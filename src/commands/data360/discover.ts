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
import { Messages } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { runDiscovery, DiscoverEndpointResult } from '../../discover/run-discovery.js';
import { DISCOVER_ENDPOINTS } from '../../discover/endpoints.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.discover');

export type Data360DiscoverResult = {
  outputDir: string;
  fetched: number;
  skipped: number;
  errored: number;
  results: DiscoverEndpointResult[];
};

export default class Data360Discover extends Data360Command<Data360DiscoverResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'output-dir': Flags.string({
      char: 'd',
      summary: messages.getMessage('flags.output-dir.summary'),
      default: './data360-discovery',
    }),
  };

  public async run(): Promise<Data360DiscoverResult> {
    const { flags } = await this.parse(Data360Discover);
    this.resolveOrg(flags['target-org']);

    const total = DISCOVER_ENDPOINTS.length;
    this.log(messages.getMessage('info.starting', [total, flags['output-dir']]));

    let completed = 0;
    const results = await runDiscovery(
      { client: this.connectRestClient },
      flags['output-dir'],
      (result) => {
        completed += 1;
        const progress = `[${completed}/${total}]`;
        if (result.status === 'fetched') {
          this.log(
            messages.getMessage('info.fetched', [progress, result.folder, result.fileName, result.itemCount ?? 0])
          );
        } else if (result.status === 'skipped') {
          this.log(
            messages.getMessage('info.skipped', [progress, result.folder, result.fileName, result.skipReason ?? ''])
          );
        } else {
          this.log(messages.getMessage('info.errored', [progress, result.folder, result.fileName, result.error ?? '']));
        }
      },
      5,
      { orgId: this.org.getOrgId(), dataSpace: flags['data-space'] }
    );

    const fetched = results.filter((r) => r.status === 'fetched').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const errored = results.filter((r) => r.status === 'error').length;

    this.log(messages.getMessage('info.summary', [fetched, skipped, errored, flags['output-dir']]));

    return { outputDir: flags['output-dir'], fetched, skipped, errored, results };
  }
}
