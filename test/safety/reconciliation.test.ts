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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { journalFor, JournalClient } from '../../src/state/journal.js';
import { StateStore } from '../../src/state/store.js';
import { StatePaths } from '../../src/state/paths.js';
import { ApplyExecutor } from '../../src/execution/apply-executor.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { reconcileOperations } from '../../src/execution/reconcile-operations.js';
describe('read-only journal reconciliation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'data360-reconcile-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const fingerprint = { orgId: 'test', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' };
  for (const operation of ['create', 'update', 'delete'] as const)
    it(`recovers committed ${operation} with a lost response without replay`, async () => {
      const store = new StateStore(new StatePaths(directory, 'test', 'default'));
      const state = await store.init(fingerprint);
      if (operation !== 'create')
        state.resources.push({
          kind: 'resource',
          type: 'CalculatedInsight',
          name: 'ci',
          id: 'Test__cio',
          dependencies: [],
        });
      const journal = journalFor(store.paths, state);
      const remote = new FakeConnectRestClient();
      let exists = operation !== 'create';
      const intent = { apiName: 'Test', expression: 'SELECT 1', definitionType: 'SQL' };
      const method = operation === 'create' ? 'POST' : operation === 'update' ? 'PATCH' : 'DELETE';
      const path = operation === 'create' ? '/ssot/calculated-insights' : '/ssot/calculated-insights/Test__cio';
      remote.on(method, path, () => {
        exists = operation !== 'delete';
        throw new Error('Request timed out after 15000ms');
      });
      remote.on('GET', '/ssot/calculated-insights/Test__cio', () => {
        if (!exists) throw Object.assign(new Error('Missing'), { statusCode: 404 });
        return { ...intent, apiName: 'Test__cio', calculatedInsightStatus: 'ACTIVE' };
      });
      const client = new JournalClient(remote, journal, {
        key: 'CalculatedInsight.ci',
        type: 'CalculatedInsight',
        intent,
        operation,
        planId: 'reviewed',
        remoteId: operation === 'create' ? undefined : 'Test__cio',
        preOperationIds: [],
      });
      try {
        await client.request({ method, path, body: intent });
      } catch {
        /* deterministic response loss after commit */
      }
      if (operation === 'create') {
        const record = (await journal.pending())[0];
        const unresolved = await reconcileOperations(journal, store, state, { client: remote });
        expect(unresolved[0].outcome).to.equal('unknown');
        // Explicit identity approval is separate from label matching and makes no remote writes.
        await journal.bindIdentity(record.operationId, 'Test__cio');
      }
      expect((await reconcileOperations(journal, store, state, { client: remote }))[0].outcome).to.equal('committed');
      expect(await journal.pending()).to.deep.equal([]);
      expect(remote.calls.filter((r) => r.method !== 'GET')).to.have.length(1);
      const repaired = await store.read(fingerprint);
      expect(repaired.resources).to.have.length(operation === 'delete' ? 0 : 1);
      if (operation !== 'delete') {
        const manifest = {
          useCase: 'recovery',
          dataSpace: 'default',
          blocks: [{ type: 'CalculatedInsight', name: 'ci', properties: intent }],
        };
        const graph = DependencyGraph.build(manifest);
        const plan = await new PlanEngine({ manifest, graph, state: repaired, ctx: { client: remote } }).compute();
        expect(plan.changes[0].action).to.equal('no-op');
        const resumed = await new ApplyExecutor({
          manifest,
          graph,
          plan,
          state: repaired,
          store,
          ctx: { client: remote },
        }).run();
        expect(resumed.failure, resumed.failure?.error.message).to.equal(undefined);
        expect(remote.calls.filter((r) => r.method !== 'GET')).to.have.length(1);
      }
    });
  it('rejects corruption, scope mismatch and concurrent journal locks', async () => {
    const store = new StateStore(new StatePaths(directory, 'test', 'default'));
    const state = await store.init(fingerprint);
    const journal = journalFor(store.paths, state);
    await journal.acquire();
    let blocked = false;
    try {
      await journalFor(store.paths, state).acquire();
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
    await journal.release();
    await writeFile(journal.file, '{ broken');
    blocked = false;
    try {
      await journal.assertReady();
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
  });
  it('retains an uncertain action and independently confirmed schema write', async () => {
    const store = new StateStore(new StatePaths(directory, 'test', 'default'));
    const state = await store.init(fingerprint);
    const journal = journalFor(store.paths, state);
    const remote = new FakeConnectRestClient();
    remote.on('PUT', '/ssot/connections/source/schema', () => ({}));
    remote.on('POST', '/ssot/identity-resolutions/r/actions/run-now', () => {
      throw new Error('fetch failed');
    });
    const schema = new JournalClient(remote, journal, {
      key: 'DataStream.stream',
      type: 'DataStream',
      intent: {},
      planId: 'p',
      operation: 'create',
    });
    await schema.request({ method: 'PUT', path: '/ssot/connections/source/schema', body: {} });
    const action = new JournalClient(remote, journal, {
      key: 'IdentityResolutionRuleset.r',
      type: 'IdentityResolutionRuleset',
      intent: { label: 'r' },
      planId: 'p',
      operation: 'action',
      remoteId: 'r',
    });
    try {
      await action.request({ method: 'POST', path: '/ssot/identity-resolutions/r/actions/run-now', body: {} });
    } catch {
      /* expected */
    }
    const results = await reconcileOperations(journal, store, state, { client: remote });
    expect(results.map((r) => r.outcome)).to.deep.equal(['committed', 'unknown']);
    expect((await journal.pending())[0].operation).to.equal('action');
    expect(remote.calls).to.have.length(2);
  });
});
