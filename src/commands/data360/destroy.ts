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
import { readFile, writeFile } from 'node:fs/promises';
import { Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfError } from '@salesforce/core';
import { reviewDeletions } from '../../execution/deletion-safety.js';
import { CascadeReview } from '../../plan/types.js';
import { Data360Command } from '../../base/data360-command.js';
import { loadManifest } from '../../manifest/loader.js';
import { DependencyGraph } from '../../graph/dependency-graph.js';
import { blockKey, ResourceBlock } from '../../manifest/types.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateLock } from '../../state/lock.js';
import { DestroyExecutor, DestroyResult } from '../../execution/destroy-executor.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.destroy');

export type Data360DestroyResult = DestroyResult;

function protectedKeys(blocks: ResourceBlock[]): Set<string> {
  return new Set(blocks.filter((b) => b.properties.protect === true).map((b) => blockKey(b)));
}

export default class Data360Destroy extends Data360Command<Data360DestroyResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'review-out': Flags.string({ summary: 'Write deletion/cascade inventory for review and exit without mutations.' }),
    'review-file': Flags.string({ summary: 'Exact previously recorded deletion/cascade review.' }),
    'approve-cascade': Flags.string({
      summary: 'Approve an exact cascade scope hash; repeat per parent. Auto-approve cannot replace this.',
      multiple: true,
    }),
    manifest: Flags.string({
      char: 'f',
      summary: messages.getMessage('flags.manifest.summary'),
      required: true,
    }),
    'reconcile-only': Flags.boolean({
      summary: 'Read-only reconciliation of pending deletions; sends no mutation requests.',
      default: false,
    }),
    step: Flags.boolean({
      summary: messages.getMessage('flags.step.summary'),
      default: false,
    }),
    'auto-approve': Flags.boolean({
      summary: messages.getMessage('flags.auto-approve.summary'),
      default: false,
    }),
  };

  public async run(): Promise<Data360DestroyResult> {
    const { flags } = await this.parse(Data360Destroy);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);
    const lock = new StateLock(paths.lockFile);

    await lock.acquire();
    try {
      const manifest = await loadManifest(flags.manifest);
      const graph = DependencyGraph.build(manifest);
      const state = await store.read(fingerprint);

      const review = flags['reconcile-only']
        ? undefined
        : await reviewDeletions(
            state,
            new Set(state.resources.filter((e) => e.kind === 'resource').map((e) => `${e.type}.${e.name}`)),
            { client: this.connectRestClient },
            protectedKeys(manifest.blocks.filter((b): b is ResourceBlock => b.kind !== 'data'))
          );
      if (flags['review-out']) {
        await writeFile(
          flags['review-out'],
          JSON.stringify(
            {
              version: 2,
              orgId: fingerprint.orgId,
              dataSpace: fingerprint.dataSpace,
              lineage: state.lineage,
              serial: state.serial,
              ...review,
            },
            null,
            2
          ),
          { flag: 'wx', mode: 0o600 }
        );
        this.log(`Read-only deletion review: ${flags['review-out']}`);
        return { destroyed: [] };
      }
      let cascades: CascadeReview[] = [];
      if (flags['review-file']) {
        const recorded = JSON.parse(await readFile(flags['review-file'], 'utf8')) as {
          version: number;
          orgId: string;
          dataSpace: string;
          lineage: string;
          serial: number;
          cascades: CascadeReview[];
        };
        if (
          recorded.version !== 2 ||
          recorded.orgId !== fingerprint.orgId ||
          recorded.dataSpace !== fingerprint.dataSpace ||
          recorded.lineage !== state.lineage ||
          (!state.resources.some((e) => e.deletionPending) && recorded.serial !== state.serial)
        )
          throw new SfError('Deletion review is stale or bound to another scope.', 'STALE_PLAN');
        cascades = recorded.cascades;
      }
      if (!flags['auto-approve'] && !flags['reconcile-only']) {
        const confirmed = await this.confirm({
          message: `Destroy ${state.resources.length} resource(s) tracked in state?`,
        });
        if (!confirmed) {
          throw new SfError('Destroy aborted: not confirmed.');
        }
      }

      const resourceBlocks = manifest.blocks.filter((b): b is ResourceBlock => (b.kind ?? 'resource') === 'resource');

      const executor = new DestroyExecutor({
        graph,
        cascades,
        cascadeApprovals: flags['approve-cascade'],
        state,
        store,
        ctx: { client: this.connectRestClient },
        protectedKeys: protectedKeys(resourceBlocks),
        reconcileOnly: flags['reconcile-only'],
        onProgress: (event): void => {
          switch (event.type) {
            case 'resource-start':
              this.log(`  ${event.key} ...`);
              break;
            case 'resource-delete-status':
              this.log(`  ${event.key}: deletion status ${event.status}`);
              break;
            case 'resource-done':
              this.log(`  ${event.key}: destroyed`);
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
        const error = new SfError(
          `Destroy failed at "${result.failure.key}": ${result.failure.error.message}`,
          result.failure.error.name
        );
        error.setData({ key: result.failure.key, pending: result.pending ?? [] });
        throw error;
      }

      return result;
    } finally {
      await lock.release();
    }
  }
}
