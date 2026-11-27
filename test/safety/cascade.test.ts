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
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { emptyState } from '../../src/state/types.js';
import { reviewDeletions, checkDeletionReview } from '../../src/execution/deletion-safety.js';
describe('exact parent cascade review', () => {
  const state = emptyState({ orgId: 'test', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' }, 'lineage');
  state.resources = [
    { kind: 'resource', type: 'AccessPolicy', name: 'p', id: 'policy', dependencies: [] },
    { kind: 'resource', type: 'AccessPolicyRule', name: 'r', id: 'policy::managed', dependencies: ['AccessPolicy.p'] },
  ];
  it('enumerates untracked rules and refuses generic approval or changed scope', async () => {
    const client = new FakeConnectRestClient();
    let rules = [{ name: 'managed' }, { name: 'untracked' }];
    client.on('GET', '/ssot/data-governance/access-policies/policy', () => ({ name: 'policy', rules }));
    const keys = new Set(['AccessPolicy.p', 'AccessPolicyRule.r']);
    const reviewed = await reviewDeletions(state, keys, { client });
    expect(reviewed.cascades[0].rules).to.have.length(2);
    let blocked = false;
    try {
      await checkDeletionReview(state, keys, { client }, reviewed.cascades);
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
    await checkDeletionReview(state, keys, { client }, reviewed.cascades, [reviewed.cascades[0].scopeHash]);
    rules = [...rules, { name: 'new' }];
    blocked = false;
    try {
      await checkDeletionReview(state, keys, { client }, reviewed.cascades, [reviewed.cascades[0].scopeHash]);
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
    expect(client.calls.every((r) => r.method === 'GET')).to.equal(true);
  });
  it('blocks standalone deletion and incomplete inventories', async () => {
    const client = new FakeConnectRestClient();
    expect((await reviewDeletions(state, new Set(['AccessPolicyRule.r']), { client })).blockers[0].code).to.equal(
      'UNSUPPORTED_DELETE'
    );
    client.on('GET', '/ssot/data-governance/access-policies/policy', () => ({ rules: [], nextPageUrl: '/unknown' }));
    expect((await reviewDeletions(state, new Set(['AccessPolicy.p']), { client })).blockers[0].code).to.equal(
      'INCOMPLETE_CASCADE'
    );
  });
});
