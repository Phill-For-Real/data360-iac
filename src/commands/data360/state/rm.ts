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
import { Args } from '@oclif/core';
import { Messages, SfError } from '@salesforce/core';
import { Data360Command } from '../../../base/data360-command.js';
import { StatePaths } from '../../../state/paths.js';
import { StateLock } from '../../../state/lock.js';
import { StateStore } from '../../../state/store.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.state.rm');

export type Data360StateRmResult = {
  removed: string;
  remoteDeleted: false;
};

export default class Data360StateRm extends Data360Command<Data360StateRmResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    name: Args.string({
      summary: messages.getMessage('flags.name.summary'),
      required: true,
    }),
  };

  public async run(): Promise<Data360StateRmResult> {
    const { flags, args } = await this.parse(Data360StateRm);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);

    const lock = new StateLock(paths.lockFile);
    await lock.acquire();
    try {
      let state;
      try {
        state = await store.read(fingerprint);
      } catch (e) {
        throw SfError.wrap(e);
      }

      const [type, name] = args.name.split('.');
      const index = state.resources.findIndex((r) => r.type === type && r.name === name);
      if (index === -1) {
        throw new SfError(`No state entry found for "${args.name}"`);
      }

      state.resources.splice(index, 1);
      await store.write(state);

      this.log(messages.getMessage('info.removed', [args.name]));
      this.log('Tracking removed only. The remote resource was not deleted.');
      return { removed: args.name, remoteDeleted: false };
    } finally {
      await lock.release();
    }
  }
}
