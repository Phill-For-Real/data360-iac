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
import { expect } from 'chai';
import { Connection } from '@salesforce/core';
import { classifyChange } from '../../src/plan/diff.js';
import { RealConnectRestClient, FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { AccessPolicyRuleAdapter } from '../../src/adapters/access-policy-rule.js';

describe('P0 safety foundations', () => {
  it('ignores live-only fields while still detecting nested declared drift', () => {
    expect(
      classifyChange(
        { expression: 'SELECT x', config: { a: 1 } },
        { expression: 'SELECT x', config: { a: 1, unmanaged: true }, status: 'ACTIVE' },
        {}
      )
    ).to.equal('no-op');
    expect(classifyChange({ config: { a: 2 } }, { config: { a: 1 } }, {})).to.equal('update-in-place');
  });
  it('does not replay PUT after a committed write loses its response', async () => {
    let writes = 0;
    const connection = {
      request: async () => {
        writes++;
        throw new Error('fetch failed');
      },
    } as unknown as Connection;
    const client = new RealConnectRestClient(connection, 10, {
      initialDelayMs: 0,
      maxDelayMs: 0,
      factor: 1,
      maxAttempts: 3,
    });
    try {
      await client.request({ method: 'PUT', path: '/ssot/activations/a', body: {} });
    } catch {
      /* expected */
    }
    expect(writes).to.equal(1);
  });
  it('reports unsupported standalone rule deletion without sending a request', async () => {
    const client = new FakeConnectRestClient();
    let rejected = false;
    try {
      await new AccessPolicyRuleAdapter().delete({ client }, 'policy::rule');
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    expect(client.calls).to.have.length(0);
  });
});
