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
import { DestroyExecutor } from '../../src/execution/destroy-executor.js';
import { StateStore } from '../../src/state/store.js';
import { StatePaths } from '../../src/state/paths.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { LoadedManifest } from '../../src/manifest/types.js';

describe('Uncertain deletion recovery', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delete-recovery-'));
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
    blocks: [{ kind: 'resource', type: 'ActivationTarget', name: 'target', properties: {} }],
  };
  for (const mode of [
    'committed-timeout',
    'unknown',
    'still-present',
    'permission-denied',
    'intent-failure',
    'final-commit-failure',
  ]) {
    it(`does not replay deletion or lose tracking after ${mode}`, async () => {
      const store = new StateStore(new StatePaths(directory, 'test-org', 'default'));
      const state = await store.init(fingerprint);
      state.resources.push({
        kind: 'resource',
        type: 'ActivationTarget',
        name: 'target',
        id: 'target-1',
        dependencies: [],
      });
      await store.write(state);
      const client = new FakeConnectRestClient();
      let exists = true;
      let failedCommit = false;
      const write = store.write.bind(store);
      store.write = async (value) => {
        if (mode === 'intent-failure') throw new Error('Disk failed before dispatch');
        if (mode === 'final-commit-failure' && !value.resources.length && !failedCommit) {
          failedCommit = true;
          throw new Error('Final state commit failed');
        }
        return write(value);
      };
      client.on('DELETE', '/ssot/activation-targets/target-1', () => {
        if (mode === 'committed-timeout' || mode === 'final-commit-failure') exists = false;
        if (mode !== 'still-present' && mode !== 'final-commit-failure')
          throw new Error('Request timed out after 15000ms');
        return {};
      });
      client.on('GET', '/ssot/activation-targets/target-1', () => {
        if (mode === 'permission-denied') throw Object.assign(new Error('Permission denied'), { statusCode: 403 });
        if (!exists)
          throw Object.assign(new Error('Activation target not found'), {
            statusCode: 404,
            errorCode: 'RESOURCE_NOT_FOUND',
          });
        return { id: 'target-1', status: 'ACTIVE' };
      });
      const first = await new DestroyExecutor({
        graph: DependencyGraph.build(manifest),
        state,
        store,
        ctx: { client },
        protectedKeys: new Set(),
        deletionPolling: { attempts: 1, intervalMs: 0 },
      }).run();
      if (mode === 'committed-timeout') {
        expect(first.failure).to.be.undefined;
        expect(first.destroyed).to.deep.equal(['ActivationTarget.target']);
      } else expect(first.failure).to.exist;
      const checkpoint = await store.read(fingerprint);
      if (mode === 'committed-timeout') expect(checkpoint.resources).to.have.length(0);
      else expect(checkpoint.resources).to.have.length(1);
      if (mode === 'unknown') expect(checkpoint.resources[0].deletionFailure?.code).to.equal('REQUEST_TIMEOUT');
      if (mode === 'intent-failure') expect(client.calls.filter((r) => r.method !== 'GET')).to.have.length(0);
      else {
        const second = await new DestroyExecutor({
          graph: DependencyGraph.build(manifest),
          state: checkpoint,
          store,
          ctx: { client },
          protectedKeys: new Set(),
          deletionPolling: { attempts: 1, intervalMs: 0 },
        }).run();
        expect(client.calls.filter((r) => r.method === 'DELETE')).to.have.length(1);
        if (mode === 'committed-timeout' || mode === 'final-commit-failure') expect(second.failure).to.be.undefined;
        else expect(second.failure).to.exist;
      }
    });
  }
  it('reconcile-only sends reads and leaves unrelated resources intact', async () => {
    const store = new StateStore(new StatePaths(directory, 'test-org', 'default'));
    const state = await store.init(fingerprint);
    state.resources.push(
      {
        kind: 'resource',
        type: 'ActivationTarget',
        name: 'target',
        id: 'target-1',
        dependencies: [],
        deletionPending: 'dispatching',
      },
      { kind: 'resource', type: 'Connection', name: 'unrelated', id: 'connection-1', dependencies: [] }
    );
    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/activation-targets/target-1', () => {
      throw Object.assign(new Error('Target not found'), { statusCode: 404, errorCode: 'RESOURCE_NOT_FOUND' });
    });
    const result = await new DestroyExecutor({
      graph: DependencyGraph.build(manifest),
      state,
      store,
      ctx: { client },
      protectedKeys: new Set(),
      deletionPolling: { attempts: 1, intervalMs: 0 },
      reconcileOnly: true,
    }).run();
    expect(result.failure).to.be.undefined;
    expect(result.destroyed).to.deep.equal(['ActivationTarget.target']);
    expect((await store.read(fingerprint)).resources.map((entry) => entry.type)).to.deep.equal(['Connection']);
    expect(client.calls.every((request) => request.method === 'GET')).to.equal(true);
  });
  it('waits for an asynchronously deleting ruleset without repeating DELETE', async () => {
    const store = new StateStore(new StatePaths(directory, 'test-org', 'default'));
    const state = await store.init(fingerprint);
    state.resources.push({
      kind: 'resource',
      type: 'IdentityResolutionRuleset',
      name: 'account',
      id: 'ruleset-1',
      dependencies: [],
    });
    const rulesetManifest: LoadedManifest = {
      useCase: 'test',
      dataSpace: 'default',
      blocks: [{ kind: 'resource', type: 'IdentityResolutionRuleset', name: 'account', properties: {} }],
    };
    const client = new FakeConnectRestClient();
    let reads = 0;
    client.on('DELETE', '/ssot/identity-resolutions/ruleset-1', () => {
      throw new Error('Request timed out after 15000ms');
    });
    client.on('GET', '/ssot/identity-resolutions/ruleset-1', () => {
      if (++reads < 3) return { id: 'ruleset-1', rulesetStatus: 'DELETING' };
      throw Object.assign(new Error('Identity Resolution not found: ruleset-1'), {
        name: 'ITEM_NOT_FOUND',
        errorCode: 'ITEM_NOT_FOUND',
      });
    });
    const observed: string[] = [];
    const result = await new DestroyExecutor({
      graph: DependencyGraph.build(rulesetManifest),
      state,
      store,
      ctx: { client },
      protectedKeys: new Set(),
      deletionPolling: { attempts: 3, intervalMs: 0, sleep: async () => undefined },
      onProgress: (event) => {
        if (event.type === 'resource-delete-status') observed.push(event.status);
      },
    }).run();
    expect(result.failure).to.be.undefined;
    expect(result.destroyed).to.deep.equal(['IdentityResolutionRuleset.account']);
    expect((await store.read(fingerprint)).resources).to.have.length(0);
    expect(client.calls.filter((request) => request.method === 'DELETE')).to.have.length(1);
    expect(reads).to.equal(3);
    expect(observed).to.deep.equal(['DELETING', 'absent']);
  });
  it('reports a bounded pending delete and retains tracking while the server is deleting', async () => {
    const store = new StateStore(new StatePaths(directory, 'test-org', 'default'));
    const state = await store.init(fingerprint);
    state.resources.push({
      kind: 'resource',
      type: 'IdentityResolutionRuleset',
      name: 'account',
      id: 'ruleset-1',
      dependencies: [],
    });
    const rulesetManifest: LoadedManifest = {
      useCase: 'test',
      dataSpace: 'default',
      blocks: [{ kind: 'resource', type: 'IdentityResolutionRuleset', name: 'account', properties: {} }],
    };
    const client = new FakeConnectRestClient();
    client.on('DELETE', '/ssot/identity-resolutions/ruleset-1', () => ({}));
    client.on('GET', '/ssot/identity-resolutions/ruleset-1', () => ({ id: 'ruleset-1', rulesetStatus: 'DELETING' }));
    const result = await new DestroyExecutor({
      graph: DependencyGraph.build(rulesetManifest),
      state,
      store,
      ctx: { client },
      protectedKeys: new Set(),
      deletionPolling: { attempts: 2, intervalMs: 0, sleep: async () => undefined },
    }).run();
    expect(result.failure?.error.name).to.equal('DELETE_IN_PROGRESS');
    expect(result.pending?.[0].observedStatus).to.equal('DELETING');
    expect((await store.read(fingerprint)).resources).to.have.length(1);
    expect(client.calls.filter((request) => request.method === 'DELETE')).to.have.length(1);
    expect(client.calls.filter((request) => request.method === 'GET')).to.have.length(2);
  });
});
