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
import { Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfError } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { getAdapter } from '../../adapters/registry.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateLock } from '../../state/lock.js';
import { computePropertiesHash } from '../../plan/properties-hash.js';
import { stripSecrets } from '../../plan/strip-secrets.js';
import { StateResourceEntry } from '../../state/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.import');

export type Data360ImportResult = {
  entry: StateResourceEntry;
  startingBlock: string;
};

export default class Data360Import extends Data360Command<Data360ImportResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    type: Flags.string({
      char: 't',
      summary: messages.getMessage('flags.type.summary'),
      required: true,
    }),
    name: Flags.string({
      char: 'n',
      summary: messages.getMessage('flags.name.summary'),
      required: true,
    }),
    'api-name': Flags.string({
      summary: messages.getMessage('flags.api-name.summary'),
      required: true,
    }),
  };

  public async run(): Promise<Data360ImportResult> {
    const { flags } = await this.parse(Data360Import);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);
    const lock = new StateLock(paths.lockFile);

    await lock.acquire();
    try {
      const adapter = getAdapter(flags.type);
      // Real resources key their business identifier under either `name` (Connection, DataStream,
      // DataModelObject, ...) or a field literally called `apiName` (Segment, CalculatedInsight) --
      // supplying both lets each adapter's lookup() match on whichever one its live items use.
      const live = await adapter.lookup(
        { client: this.connectRestClient },
        { name: flags['api-name'], apiName: flags['api-name'] }
      );
      if (!live) {
        throw new SfError(`No live ${flags.type} found with API name "${flags['api-name']}" to import.`);
      }

      const sanitizedProperties = stripSecrets(live.properties) as Record<string, unknown>;
      const state = await store.read(fingerprint);

      const alreadyTracked = state.resources.some((r) => r.type === flags.type && r.name === flags.name);
      if (alreadyTracked) {
        throw new SfError(
          `"${flags.type}.${flags.name}" is already tracked in state. Use "data360 state show" to inspect it, ` +
            'or choose a different --name.'
        );
      }

      const entry: StateResourceEntry = {
        kind: 'resource',
        type: flags.type,
        name: flags.name,
        id: live.id,
        apiName: live.apiName,
        propertiesHash: computePropertiesHash(sanitizedProperties),
        dependencies: [],
        adopted: true,
        lastAppliedAt: new Date().toISOString(),
      };

      state.resources.push(entry);
      await store.write(state);

      const startingBlock = JSON.stringify(
        {
          kind: 'resource',
          type: flags.type,
          name: flags.name,
          properties: sanitizedProperties,
        },
        null,
        2
      );

      this.log(messages.getMessage('info.imported', [flags.type, flags['api-name']]));
      this.log(startingBlock);

      return { entry, startingBlock };
    } finally {
      await lock.release();
    }
  }
}
