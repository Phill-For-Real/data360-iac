/*
 * Copyright 2025, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { readFile } from 'node:fs/promises';
import { Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfError } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { loadManifest } from '../../manifest/loader.js';
import { DependencyGraph } from '../../graph/dependency-graph.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateLock } from '../../state/lock.js';
import { PlanEngine } from '../../plan/engine.js';
import { formatPlanSummary, hasPendingChanges } from '../../plan/format.js';
import { safeIntent } from '../../plan/safe-intent.js';
import { computePropertiesHash } from '../../plan/properties-hash.js';
import { SafetyError } from '../../execution/deletion-safety.js';
import { Plan } from '../../plan/types.js';
import { ApplyExecutor, ApplyResult } from '../../execution/apply-executor.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.apply');

export type Data360ApplyResult = ApplyResult;

export default class Data360Apply extends Data360Command<Data360ApplyResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'approve-cascade': Flags.string({
      summary: 'Approve the exact recorded cascade scope hash; repeat per parent.',
      multiple: true,
    }),
    manifest: Flags.string({
      char: 'f',
      summary: messages.getMessage('flags.manifest.summary'),
    }),
    planfile: Flags.string({
      summary: messages.getMessage('flags.planfile.summary'),
    }),
    step: Flags.boolean({
      summary: messages.getMessage('flags.step.summary'),
      default: false,
    }),
    'auto-approve': Flags.boolean({
      summary: messages.getMessage('flags.auto-approve.summary'),
      default: false,
    }),
    'baseline-intent': Flags.boolean({
      summary: 'After review, record current declared managed fields for legacy state using local writes only.',
      default: false,
    }),
    adopt: Flags.boolean({
      summary: messages.getMessage('flags.adopt.summary'),
      default: false,
    }),
  };

  // eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
  public async run(): Promise<Data360ApplyResult> {
    const { flags } = await this.parse(Data360Apply);
    this.resolveOrg(flags['target-org']);

    if (!flags.manifest) {
      throw new SfError('--manifest is required, including when executing a saved plan.');
    }

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);
    const lock = new StateLock(paths.lockFile);

    await lock.acquire();
    try {
      const manifest = await loadManifest(flags.manifest);
      const graph = DependencyGraph.build(manifest);
      const state = await store.read(fingerprint);
      const unresolvedDelete = state.resources.find((entry) => entry.deletionPending);
      if (unresolvedDelete) {
        throw new SfError(
          'Unresolved deletion blocks apply. Inspect with data360 destroy --reconcile-only before any new writes.',
          'UNCERTAIN_DELETE'
        ).setData({
          key: `${unresolvedDelete.type}.${unresolvedDelete.name}`,
          phase: String(unresolvedDelete.deletionPending),
        });
      }

      let plan: Plan;
      if (flags.planfile) {
        plan = JSON.parse(await readFile(flags.planfile, 'utf8')) as Plan;
        const identity = plan.identity;
        if (
          plan.version !== 2 ||
          identity?.orgId !== fingerprint.orgId ||
          identity.dataSpace !== fingerprint.dataSpace ||
          identity.lineage !== state.lineage ||
          identity.serial !== state.serial ||
          identity.manifestHash !== computePropertiesHash(safeIntent(manifest) as Record<string, unknown>)
        )
          throw new SfError(
            'Saved plan is incompatible or stale. Generate a new version 2 plan for this exact manifest and state.',
            'STALE_PLAN'
          );
        const current = await new PlanEngine({
          manifest,
          graph,
          state,
          ctx: { client: this.connectRestClient },
        }).compute();
        if (computePropertiesHash(current) !== computePropertiesHash(plan))
          throw new SfError(
            'Current safety observations differ from the saved plan. Generate and review a new plan.',
            'STALE_PLAN'
          );
      } else {
        const engine = new PlanEngine({ manifest, graph, state, ctx: { client: this.connectRestClient } });
        plan = await engine.compute();
      }

      this.log(formatPlanSummary(plan));
      if (plan.blockers?.length)
        throw new SfError(new SafetyError(plan.blockers).message, 'SAFETY_BLOCKED').setData({
          blockers: plan.blockers,
        });

      if (plan.adoptionCandidates.length > 0 && !flags.adopt) {
        const interactive = !this.jsonEnabled() && process.stdin.isTTY === true;
        if (!interactive) {
          throw new SfError(
            'Adoption candidates were found but this is a non-interactive session. Re-run with ' +
              '--adopt, or run "data360 import" first for each candidate.'
          );
        }
        const confirmed = await this.confirm({
          message: 'Adoption candidates were found. Adopt them into state and continue?',
        });
        if (!confirmed) {
          throw new SfError('Apply aborted: adoption candidates were not confirmed.');
        }
      }

      const pendingLifecycles = state.resources.filter((entry) => entry.lifecyclePending);
      for (const entry of pendingLifecycles)
        this.log(`Pending lifecycle: ${entry.type}.${entry.name} (${String(entry.lifecyclePending)})`);
      if (
        !flags['baseline-intent'] &&
        !manifest.blocks.some(
          (b) =>
            b.kind !== 'data' &&
            state.resources.some(
              (e) => `${e.type}.${e.name}` === `${b.type}.${b.name}` && e.protected !== (b.properties.protect === true)
            )
        ) &&
        !hasPendingChanges(plan) &&
        !pendingLifecycles.length &&
        !state.resources.some((entry) => entry.deletionPending)
      ) {
        return { completed: [] };
      }

      if (!flags['auto-approve']) {
        const confirmed = await this.confirm({ message: 'Apply these changes?' });
        if (!confirmed) {
          throw new SfError('Apply aborted: not confirmed.');
        }
      }

      const executor = new ApplyExecutor({
        manifest,
        graph,
        plan,
        state,
        store,
        ctx: { client: this.connectRestClient },
        cascadeApprovals: flags['approve-cascade'],
        baselineLegacy: flags['baseline-intent'],
        step: flags.step,
        onStageComplete: flags.step
          ? async (stageName): Promise<boolean> => {
              this.log(`Stage "${stageName}" complete.`);
              return this.confirm({ message: 'Continue to the next stage?' });
            }
          : undefined,
        onProgress: (event): void => {
          switch (event.type) {
            case 'stage-start':
              this.log(`-- Stage "${event.stageName}" (${event.keys.length} resource(s)) --`);
              break;
            case 'resource-start':
              this.log(`  ${event.key} ...`);
              break;
            case 'resource-waiting-job':
              this.log(`  ${event.key}: waiting for job to complete ...`);
              break;
            case 'resource-job-status':
              this.log(`    ...${event.key} still ${event.status ?? 'in progress'}`);
              break;
            case 'resource-done':
              this.log(`  ${event.key}: done`);
              break;
            case 'resource-failed':
              this.log(`  ${event.key}: FAILED -- ${event.error.message}`);
              break;
            default:
              break;
          }
        },
      });

      const result = await executor.run();

      if (result.failure) {
        throw new SfError(`Apply failed at "${result.failure.key}": ${result.failure.error.message}`);
      }

      return result;
    } finally {
      await lock.release();
    }
  }
}
