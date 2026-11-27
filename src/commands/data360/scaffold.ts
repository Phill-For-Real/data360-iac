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
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Org, SfError } from '@salesforce/core';
import { offlineInventory, liveInventory } from '../../scaffold/inventory.js';
import { scaffold, publishScaffold, ScaffoldReport } from '../../scaffold/scaffold.js';
import { RealConnectRestClient, ConnectRestClient } from '../../connect-rest/client.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateFile } from '../../state/types.js';
export type ScaffoldResult = { manifestPath?: string; reportPath: string; report: ScaffoldReport };
export default class Data360Scaffold extends SfCommand<ScaffoldResult> {
  public static readonly summary = 'Convert selected discovered resources to a manifest and a separate safety report.';
  public static readonly description =
    'Offline input never authenticates or accesses the network. Live input uses GET only. Selection proposes management but does not import, adopt or acquire ownership. Review all destroys before applying a subset against shared state.';
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --from-discovery ./data360-discovery --select CalculatedInsight:VehicleHealthScore__cio --use-case existing-assets --data-space default --out ./generated/manifest.json',
    '<%= config.bin %> <%= command.id %> -o sandbox --select DataStream:RECORD_ID --use-case existing-assets --out ./generated/manifest.json --json',
  ];
  public static readonly flags = {
    'from-discovery': Flags.string({
      summary: 'Existing discover output directory; never falls back to live access.',
      exclusive: ['target-org'],
    }),
    'target-org': Flags.string({
      char: 'o',
      summary: 'Authenticated org alias for read-only live input.',
      exclusive: ['from-discovery'],
    }),
    select: Flags.string({
      summary: 'Root selector Type:identifier. Repeat for multiple roots.',
      multiple: true,
      required: true,
    }),
    'use-case': Flags.string({ summary: 'Generated manifest useCase.', required: true }),
    'data-space': Flags.string({ summary: 'Generated manifest Data Space.', default: 'default' }),
    out: Flags.string({ summary: 'Manifest path; report is written to <out>.report.json.', required: true }),
    overwrite: Flags.boolean({ summary: 'Explicit consent to replace existing output files.', default: false }),
  };
  // eslint-disable-next-line complexity -- keep offline source isolation and scoped ownership checks explicit.
  public async run(): Promise<ScaffoldResult> {
    const { flags } = await this.parse(Data360Scaffold);
    if (!flags['from-discovery'] && !flags['target-org']) throw new SfError('Choose --from-discovery or --target-org.');
    let client: ConnectRestClient | undefined;
    let orgId: string | undefined;
    let state: StateFile | undefined;
    if (flags['target-org']) {
      const org = await Org.create({ aliasOrUsername: flags['target-org'] });
      orgId = org.getOrgId();
      client = new RealConnectRestClient(org.getConnection());
      const paths = new StatePaths(
        process.cwd(),
        org.getField<string>(Org.Fields.ALIAS) ?? org.getUsername() ?? orgId,
        flags['data-space']
      );
      const store = new StateStore(paths);
      if (await store.exists())
        state = await store.read({
          orgId,
          instanceUrl: org.getField<string>(Org.Fields.INSTANCE_URL) ?? '',
          targetOrgAlias: flags['target-org'],
          dataSpace: flags['data-space'],
        });
    }
    const inventory = flags['from-discovery']
      ? await offlineInventory(flags['from-discovery'])
      : await liveInventory({ client: client! }, orgId!, flags['data-space']);
    if (!state && inventory.source.orgId) {
      const files = (await readdir(process.cwd())).filter((name) => /^data360\..*\.state\.json$/.test(name)).sort();
      for (const file of files) {
        try {
          // eslint-disable-next-line no-await-in-loop -- only read local tracking with matching source metadata.
          const candidate = JSON.parse(await readFile(join(process.cwd(), file), 'utf8')) as StateFile;
          if (
            candidate.orgFingerprint?.orgId === inventory.source.orgId &&
            candidate.orgFingerprint.dataSpace === flags['data-space']
          ) {
            if (state && state.lineage !== candidate.lineage) {
              inventory.limits.push(
                'Multiple local tracking lineages exist for this scope; ownership must be reviewed.'
              );
              break;
            }
            state = candidate;
          }
        } catch {
          inventory.limits.push('A local state file could not be read; omitted tracking scope remains unknown.');
        }
      }
    }
    if (!state)
      inventory.limits.push('Scoped local tracking was unavailable; omitted tracked resources cannot be enumerated.');
    const generated = await scaffold({
      inventory,
      selectors: flags.select,
      useCase: flags['use-case'],
      dataSpace: flags['data-space'],
      ctx: client ? { client } : undefined,
      state,
    });
    const published = await publishScaffold(generated, flags.out, flags.overwrite);
    if (generated.report.blockers.length)
      throw new SfError(
        'Scaffolding blocked: required configuration or dependencies are unavailable. Review the report; no manifest was published.',
        'SCAFFOLD_BLOCKED'
      ).setData({ reportPath: published.reportPath, blockers: generated.report.blockers });
    this.log(`Manifest: ${published.manifestPath!}; report: ${published.reportPath}`);
    return { ...published, report: generated.report };
  }
}
