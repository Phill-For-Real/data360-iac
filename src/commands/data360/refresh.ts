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
import { Messages } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateLock } from '../../state/lock.js';
import { refreshTrackedResources } from '../../state/refresh-tracked.js';
import { StateFile } from '../../state/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.refresh');

export type Data360RefreshResult = {
  resourceCount: number;
  state: StateFile;
};

export default class Data360Refresh extends Data360Command<Data360RefreshResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public async run(): Promise<Data360RefreshResult> {
    const { flags } = await this.parse(Data360Refresh);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);
    const lock = new StateLock(paths.lockFile);

    await lock.acquire();
    try {
      const state = await store.read(fingerprint);
      const refreshed = await refreshTrackedResources(state, { client: this.connectRestClient });
      const written = await store.write(refreshed);

      this.log(messages.getMessage('info.refreshed', [written.resources.length]));
      return { resourceCount: written.resources.length, state: written };
    } finally {
      await lock.release();
    }
  }
}
