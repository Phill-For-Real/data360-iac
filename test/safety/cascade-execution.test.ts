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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { StateStore } from '../../src/state/store.js';
import { StatePaths } from '../../src/state/paths.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { DestroyExecutor } from '../../src/execution/destroy-executor.js';
import { reviewDeletions } from '../../src/execution/deletion-safety.js';
describe('reviewed cascade execution', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'data360-cascade-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const fingerprint = { orgId: 'test', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' };
  for (const mode of ['confirmed', 'uncertain', 'expanded', 'protected', 'unrelated'] as const)
    it(`retains ownership and enforces reviewed scope for ${mode}`, async () => {
      const store = new StateStore(new StatePaths(directory, 'test', 'default'));
      let state = await store.init(fingerprint);
      state.resources = [
        { kind: 'resource', type: 'AccessPolicy', name: 'p', id: 'policy', dependencies: [] },
        {
          kind: 'resource',
          type: 'AccessPolicyRule',
          name: 'r',
          id: 'policy::tracked',
          dependencies: ['AccessPolicy.p'],
          protected: mode === 'protected',
        },
        { kind: 'resource', type: 'Connection', name: 'unrelated', id: 'unrelated', dependencies: [] },
      ];
      state = await store.write(state);
      const graph = DependencyGraph.build({
        useCase: 'test',
        dataSpace: 'default',
        blocks: [
          { type: 'AccessPolicy', name: 'p', properties: {} },
          { type: 'AccessPolicyRule', name: 'r', properties: {}, dependsOn: ['AccessPolicy.p'] },
          { type: 'Connection', name: 'unrelated', properties: {} },
        ],
      });
      const client = new FakeConnectRestClient();
      let exists = true;
      let rules = [{ name: 'tracked' }, { name: 'untracked' }];
      client.on('GET', '/ssot/data-governance/access-policies/policy', () => {
        if (!exists) throw Object.assign(new Error('Missing parent'), { statusCode: 404 });
        return { name: 'policy', rules };
      });
      for (const rule of rules)
        client.on('GET', '/ssot/data-governance/access-policies/policy/rules/' + rule.name, () => {
          if (!exists) throw Object.assign(new Error('Missing child'), { statusCode: 404 });
          return rule;
        });
      client.on('DELETE', '/ssot/data-governance/access-policies/policy', () => {
        if (mode === 'confirmed' || mode === 'unrelated') exists = false;
        else throw new Error('Request timed out after 15000ms');
        return {};
      });
      const keys = new Set(['AccessPolicy.p', 'AccessPolicyRule.r']);
      const review = await reviewDeletions(state, keys, { client });
      if (mode === 'expanded') rules = [...rules, { name: 'new-untracked' }];
      const result = await new DestroyExecutor({
        graph,
        state,
        store,
        ctx: { client },
        protectedKeys: new Set(),
        deletionKeys: keys,
        cascades: review.cascades,
        cascadeApprovals: review.cascades.map((c) => c.scopeHash),
        deletionPolling: { attempts: 1 },
      }).run();
      const after = await store.read(fingerprint);
      if (mode === 'confirmed' || mode === 'unrelated') {
        expect(result.failure).to.equal(undefined);
        expect(after.resources.map((e) => e.name)).to.deep.equal(['unrelated']);
        expect(client.calls.filter((r) => r.method === 'DELETE')).to.have.length(1);
      } else {
        expect(result.failure).to.exist;
        expect(after.resources).to.have.length(3);
        expect(client.calls.filter((r) => r.method !== 'GET')).to.have.length(mode === 'uncertain' ? 1 : 0);
      }
      expect(client.calls.some((r) => r.method === 'DELETE' && r.path.includes('/rules/'))).to.equal(false);
    });
});
