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
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Org } from '@salesforce/core';
import { ConnectRestClient, ConnectRestMethod, RealConnectRestClient } from '../connect-rest/client.js';
import { OrgFingerprint } from '../state/types.js';

/**
 * Base class for every org-touching data360 command. Resolves --target-org (falling back to the
 * configured default org) through the standard sf auth store, then exposes a ConnectRestClient
 * built from that connection -- no command ever handles a token or OAuth flow itself.
 */
export abstract class Data360Command<T> extends SfCommand<T> {
  public static readonly baseFlags = {
    ...SfCommand.baseFlags,
    'target-org': Flags.requiredOrg(),
    'data-space': Flags.string({
      summary: 'The Data Space this command targets.',
      default: 'default',
    }),
  };

  protected org!: Org;
  protected connectRestClient!: ConnectRestClient;

  protected resolveOrg(org: Org): void {
    this.org = org;
    this.connectRestClient = new RealConnectRestClient(
      org.getConnection(),
      undefined,
      undefined,
      // A request that failed and is about to retry would otherwise be invisible -- the retry
      // itself has a real, bounded cap (see DEFAULT_BACKOFF_POLICY's doc comment), but with no
      // progress event at all, several seconds of a request silently retrying can look identical
      // to the whole command hanging. Every command gets this baseline visibility for free.
      (method: ConnectRestMethod, path: string, attempt: number, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.warn(`Request ${method} ${path} failed (attempt ${attempt}), retrying: ${message}`);
      },
      60_000 // A single bounded mutation attempt; never replay a timed-out write.
    );
  }

  protected orgFingerprint(dataSpace: string): OrgFingerprint {
    return {
      orgId: this.org.getOrgId(),
      instanceUrl: this.org.getField<string>(Org.Fields.INSTANCE_URL) ?? '',
      targetOrgAlias: this.org.getField<string>(Org.Fields.ALIAS) ?? this.org.getUsername() ?? this.org.getOrgId(),
      dataSpace,
    };
  }
}
