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
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { LoadedManifest } from '../../src/manifest/types.js';
import { DestroyExecutor, ProtectedResourceError } from '../../src/execution/destroy-executor.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { StatePaths } from '../../src/state/paths.js';
import { StateStore } from '../../src/state/store.js';
import { OrgFingerprint, StateResourceEntry } from '../../src/state/types.js';

const FINGERPRINT: OrgFingerprint = {
  orgId: '00Dxx0000000001EAA',
  instanceUrl: 'https://example.my.salesforce.com',
  targetOrgAlias: 'data360-prod',
  dataSpace: 'default',
};

function manifestFrom(blocks: LoadedManifest['blocks']): LoadedManifest {
  return { useCase: 'uc', dataSpace: 'default', blocks };
}

function entry(type: string, name: string, id: string): StateResourceEntry {
  return { kind: 'resource', type, name, id, dependencies: [] };
}

describe('DestroyExecutor', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-destroy-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('destroys resources in the correct reverse topological order', async () => {
    const manifest = manifestFrom([
      { kind: 'resource', type: 'Connection', name: 'a', properties: {} },
      { kind: 'resource', type: 'DataStream', name: 'b', properties: { ref: '${Connection.a.id}' } },
      { kind: 'resource', type: 'DataLakeObject', name: 'c', properties: { ref: '${DataStream.b.id}' } },
    ]);
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);
    initialState.resources.push(
      entry('Connection', 'a', 'conn-1'),
      entry('DataStream', 'b', 'stream-1'),
      entry('DataLakeObject', 'c', 'dlo-1')
    );
    const state = await store.write(initialState);

    const deletedOrder: string[] = [];
    const client = new FakeConnectRestClient();
    client.on('DELETE', '/ssot/connections/conn-1', () => {
      deletedOrder.push('Connection.a');
      return {};
    });
    // DataStreamAdapter.delete() always appends this query param, defaulting to also deleting
    // the materialized DLO.
    client.on('DELETE', '/ssot/data-streams/stream-1?shouldDeleteDataLakeObject=true', () => {
      deletedOrder.push('DataStream.b');
      return {};
    });
    client.on('DELETE', '/ssot/data-lake-objects/dlo-1', () => {
      deletedOrder.push('DataLakeObject.c');
      return {};
    });

    const executor = new DestroyExecutor({ graph, state, store, ctx: { client }, protectedKeys: new Set() });
    const result = await executor.run();

    expect(result.failure).to.be.undefined;
    expect(deletedOrder).to.deep.equal(['DataLakeObject.c', 'DataStream.b', 'Connection.a']);

    const finalState = await store.read(FINGERPRINT);
    expect(finalState.resources).to.have.lengthOf(0);
  });

  it('destroys a resource tracked in state but no longer declared in the manifest (e.g. renamed away)', async () => {
    const manifest = manifestFrom([{ kind: 'resource', type: 'Connection', name: 'account', properties: {} }]);
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);
    initialState.resources.push(
      entry('Connection', 'account', 'conn-1'),
      // Tracked from a prior apply of a manifest that has since renamed/removed this block --
      // it has no node in the current manifest's graph at all.
      entry('Connection', 'core_crm_connection', 'conn-old-1')
    );
    const state = await store.write(initialState);

    const deletedOrder: string[] = [];
    const client = new FakeConnectRestClient();
    client.on('DELETE', '/ssot/connections/conn-1', () => {
      deletedOrder.push('Connection.account');
      return {};
    });
    client.on('DELETE', '/ssot/connections/conn-old-1', () => {
      deletedOrder.push('Connection.core_crm_connection');
      return {};
    });

    const executor = new DestroyExecutor({ graph, state, store, ctx: { client }, protectedKeys: new Set() });
    const result = await executor.run();

    expect(result.failure).to.be.undefined;
    expect(deletedOrder).to.include.members(['Connection.account', 'Connection.core_crm_connection']);

    const finalState = await store.read(FINGERPRINT);
    expect(finalState.resources).to.have.lengthOf(0);
  });

  it('refuses to destroy a resource marked protect: true without an explicit override', async () => {
    const manifest = manifestFrom([
      { kind: 'resource', type: 'Segment', name: 'guarded', properties: { protect: true } },
    ]);
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);
    initialState.resources.push(entry('Segment', 'guarded', 'seg-1'));
    const state = await store.write(initialState);

    const client = new FakeConnectRestClient();
    const executor = new DestroyExecutor({
      graph,
      state,
      store,
      ctx: { client },
      protectedKeys: new Set(['Segment.guarded']),
    });

    const result = await executor.run();

    expect(result.failure?.error).to.be.instanceOf(ProtectedResourceError);
    expect(client.calls).to.have.lengthOf(0);

    const finalState = await store.read(FINGERPRINT);
    expect(finalState.resources).to.have.lengthOf(1);
  });
});
