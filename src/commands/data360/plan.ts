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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfError } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { loadManifest } from '../../manifest/loader.js';
import { DependencyGraph } from '../../graph/dependency-graph.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { PlanEngine } from '../../plan/engine.js';
import { formatPlanSummary, hasPendingChanges } from '../../plan/format.js';
import { Plan } from '../../plan/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.plan');

export type Data360PlanResult = Plan;

export default class Data360Plan extends Data360Command<Data360PlanResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    manifest: Flags.string({
      char: 'f',
      summary: messages.getMessage('flags.manifest.summary'),
      required: true,
    }),
    step: Flags.boolean({
      summary: messages.getMessage('flags.step.summary'),
      default: false,
    }),
    out: Flags.string({
      summary: messages.getMessage('flags.out.summary'),
    }),
    'detailed-exitcode': Flags.boolean({
      summary: messages.getMessage('flags.detailed-exitcode.summary'),
      default: false,
    }),
  };

  public async run(): Promise<Data360PlanResult> {
    const { flags } = await this.parse(Data360Plan);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);

    let plan: Plan;
    try {
      const manifest = await loadManifest(flags.manifest);
      const graph = DependencyGraph.build(manifest);
      const state = await store.read(fingerprint);
      const engine = new PlanEngine({ manifest, graph, state, ctx: { client: this.connectRestClient } });
      plan = await engine.compute();
    } catch (e) {
      throw SfError.wrap(e);
    }

    this.log(formatPlanSummary(plan));

    if (flags.out) {
      await mkdir(paths.plansDir, { recursive: true });
      const outPath = join(paths.plansDir, flags.out);
      await writeFile(outPath, JSON.stringify(plan, null, 2));
      this.log(messages.getMessage('info.saved', [outPath]));
    }

    if (flags['detailed-exitcode'] && hasPendingChanges(plan)) {
      this.exit(2);
    }

    return plan;
  }
}
