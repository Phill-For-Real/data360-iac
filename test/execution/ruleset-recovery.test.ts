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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { ApplyExecutor } from '../../src/execution/apply-executor.js';
import { StateStore } from '../../src/state/store.js';
import { StatePaths } from '../../src/state/paths.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { LoadedManifest } from '../../src/manifest/types.js';
import { Plan } from '../../src/plan/types.js';

describe('Ruleset lifecycle checkpoints', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ruleset-checkpoint-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const fingerprint = {
    orgId: 'test-org',
    instanceUrl: 'https://example.invalid',
    targetOrgAlias: 'test-org',
    dataSpace: 'default',
  };
  const manifest: LoadedManifest = {
    useCase: 'test',
    dataSpace: 'default',
    blocks: [
      {
        kind: 'resource',
        type: 'IdentityResolutionRuleset',
        name: 'account',
        properties: { label: 'Account', configurationType: 'Account', matchRules: [], reconciliationRules: [] },
      },
    ],
  };
  const plan: Plan = {
    changes: [
      {
        key: 'IdentityResolutionRuleset.account',
        type: 'IdentityResolutionRuleset',
        name: 'account',
        action: 'create',
      },
    ],
    adoptionCandidates: [],
    destroys: [],
    warnings: [],
    summary: { create: 1, update: 0, replace: 0, destroy: 0, noOp: 0, total: 1 },
  };
  for (const mode of [
    'read-failure',
    'action-timeout',
    'commit-failure',
    'intent-persistence-failure',
    'final-state-failure',
  ]) {
    it(`retains the ruleset identity and does not replay mutations after ${mode}`, async () => {
      const store = new StateStore(new StatePaths(directory, 'test-org', 'default'));
      const state = await store.init(fingerprint);
      const client = new FakeConnectRestClient();
      client.on('GET', '/ssot/identity-resolutions', () => ({ identityResolutions: [] }));
      let readFailed = false;
      let actionCommitted = false;
      let failStore = false;
      const write = store.write.bind(store);
      let finalFailed = false;
      store.write = async (value) => {
        if (mode === 'final-state-failure' && actionCommitted && !value.resources[0].lifecyclePending && !finalFailed) {
          finalFailed = true;
          throw new Error('Injected final state failure');
        }
        if (failStore) throw new Error('Injected disk failure');
        return write(value);
      };
      client.on('POST', '/ssot/identity-resolutions', (request) => ({
        ...(request.body as object),
        id: 'ruleset-1',
        rulesetStatus: 'PUBLISHED',
      }));
      client.on('GET', '/ssot/identity-resolutions/ruleset-1', () => {
        if (mode === 'read-failure' && !readFailed) {
          readFailed = true;
          throw new Error('Injected read failure');
        }
        return { id: 'ruleset-1', label: 'Account', rulesetStatus: 'PUBLISHED' };
      });
      client.on('POST', '/ssot/identity-resolutions/ruleset-1/actions/run-now', () => {
        actionCommitted = true;
        if (mode === 'action-timeout') throw new Error('Request timed out after 15000ms');
        if (mode === 'commit-failure') failStore = true;
        return {};
      });
      if (mode === 'intent-persistence-failure') {
        const baseWrite = store.write.bind(store);
        let writes = 0;
        store.write = async (value) => {
          if (++writes === 2) throw new Error('Injected intent persistence failure');
          return baseWrite(value);
        };
      }
      const first = await new ApplyExecutor({
        manifest,
        graph: DependencyGraph.build(manifest),
        plan,
        state,
        store,
        ctx: { client },
      }).run();
      expect(first.failure).to.exist;
      const checkpoint = await store.read(fingerprint);
      expect(checkpoint.resources[0].id).to.equal('ruleset-1');
      expect(client.calls.filter((r) => r.path === '/ssot/identity-resolutions' && r.method === 'POST')).to.have.length(
        1
      );
      if (mode === 'intent-persistence-failure') expect(actionCommitted).to.equal(false);
      failStore = false;
      store.write = write;
      const second = await new ApplyExecutor({
        manifest,
        graph: DependencyGraph.build(manifest),
        plan,
        state: checkpoint,
        store,
        ctx: { client },
      }).run();
      if (mode === 'action-timeout' || mode === 'commit-failure') {
        expect(second.failure).to.exist;
        expect(client.calls.filter((r) => r.path.endsWith('/actions/run-now'))).to.have.length(1);
      } else expect(second.failure).to.exist;
      expect(client.calls.filter((r) => r.path === '/ssot/identity-resolutions' && r.method === 'POST')).to.have.length(
        1
      );
    });
  }
});
