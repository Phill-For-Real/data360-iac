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
import { SfError } from '@salesforce/core';
import { Data360Command } from '../../base/data360-command.js';
import { StatePaths } from '../../state/paths.js';
import { StateStore } from '../../state/store.js';
import { StateLock } from '../../state/lock.js';
import { journalFor, OperationRecord } from '../../state/journal.js';
import { reconcileOperations, ReconciliationResult } from '../../execution/reconcile-operations.js';
export type OperationsResult = { operations: OperationRecord[]; reconciliation: ReconciliationResult[] };
export default class Data360Operations extends Data360Command<OperationsResult> {
  public static readonly summary =
    'Inspect pending operations and reconcile their original intent using remote reads only.';
  public static readonly description =
    'Never retries remote mutations. Reconciliation may repair local state and journals after authoritative evidence. Unknown action outcomes remain blocked.';
  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> -o sandbox --json',
    '<%= config.bin %> <%= command.id %> -o sandbox --reconcile --json',
  ];
  public static readonly flags = {
    'bind-identity': Flags.string({
      summary:
        'Explicitly approve original operationId=remoteId for read-only intent verification. Never selects an ambiguous candidate automatically.',
      multiple: true,
    }),
    reconcile: Flags.boolean({
      summary: 'Read remote evidence and durably repair confirmed local operations.',
      default: false,
    }),
  };
  public async run(): Promise<OperationsResult> {
    const { flags } = await this.parse(Data360Operations);
    this.resolveOrg(flags['target-org']);
    const fingerprint = this.orgFingerprint(flags['data-space']);
    const paths = new StatePaths(process.cwd(), fingerprint.targetOrgAlias, fingerprint.dataSpace);
    const store = new StateStore(paths);
    const lock = new StateLock(paths.lockFile);
    await lock.acquire();
    try {
      const state = await store.read(fingerprint);
      const journal = journalFor(paths, state);
      await journal.acquire();
      try {
        for (const binding of flags['bind-identity'] ?? []) {
          const equal = binding.indexOf('=');
          const operationId = binding.slice(0, equal);
          const remoteId = binding.slice(equal + 1);
          // eslint-disable-next-line no-await-in-loop -- explicit local binding followed by read-only validation.
          const record = (await journal.pending()).find((r) => r.operationId === operationId);
          if (equal < 1 || !remoteId || record?.operation !== 'create' || record.preOperationIds?.includes(remoteId))
            throw new SfError('Invalid or conflicting recovery identity binding.', 'RECOVERY_CONFLICT');
          // eslint-disable-next-line no-await-in-loop -- durable user-approved identity, never a remote write.
          await journal.bindIdentity(operationId, remoteId);
        }
        const reconciliation = flags.reconcile
          ? await reconcileOperations(journal, store, state, {
              client: this.connectRestClient,
              onJobPoll: (status) => this.log(status ?? 'Reading original operation evidence'),
            })
          : [];
        const operations = await journal.pending();
        const result = { operations, reconciliation };
        if (flags.reconcile && operations.length)
          throw new SfError(
            'Some operations remain unresolved. No remote mutation was replayed.',
            'RECOVERY_REQUIRED'
          ).setData({ reconciliation, pendingOperationIds: operations.map((r) => r.operationId) });
        this.log(JSON.stringify(result, null, 2));
        return result;
      } finally {
        await journal.release();
      }
    } finally {
      await lock.release();
    }
  }
}
