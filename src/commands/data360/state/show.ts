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
import { StateStore } from '../../../state/store.js';
import { StateResourceEntry } from '../../../state/types.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.state.show');

export type Data360StateShowResult = StateResourceEntry;

export default class Data360StateShow extends Data360Command<Data360StateShowResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly examples = messages.getMessages('examples');

  public static readonly args = {
    name: Args.string({
      summary: messages.getMessage('flags.name.summary'),
      required: true,
    }),
  };

  public async run(): Promise<Data360StateShowResult> {
    const { flags, args } = await this.parse(Data360StateShow);
    this.resolveOrg(flags['target-org']);

    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);

    let state;
    try {
      state = await store.read(fingerprint);
    } catch (e) {
      throw SfError.wrap(e);
    }

    const [type, name] = args.name.split('.');
    const entry = state.resources.find((r) => r.type === type && r.name === name);
    if (!entry) {
      throw new SfError(`No state entry found for "${args.name}"`);
    }

    this.logJson(entry);
    return entry;
  }
}
