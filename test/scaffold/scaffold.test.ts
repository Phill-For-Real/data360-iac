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
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { convertObserved } from '../../src/adapters/configuration.js';
import { scaffold, manifestBytes, publishScaffold, parseSelector } from '../../src/scaffold/scaffold.js';
import { Inventory, offlineInventory } from '../../src/scaffold/inventory.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { StatePaths } from '../../src/state/paths.js';
import { StateStore } from '../../src/state/store.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { ApplyExecutor } from '../../src/execution/apply-executor.js';
describe('scaffold conversion and ownership', () => {
  let fixtures: Record<string, Record<string, unknown>>;
  let dir: string;
  beforeEach(async () => {
    fixtures = JSON.parse(await readFile('test/scaffold/observed-fixtures.json', 'utf8')) as typeof fixtures;
    dir = await mkdtemp(join(tmpdir(), 'data360-scaffold-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  it('converts every minimum supported managed shape using request/response fixtures', () => {
    for (const [type, observed] of Object.entries(fixtures)) {
      const result = convertObserved(type, observed);
      expect(result.blockers, type).to.deep.equal([]);
      expect(result.properties, type).not.to.have.property('status');
      expect(result.properties, type).not.to.have.property('id');
    }
    const activation = convertObserved('Activation', fixtures.Activation).properties;
    const point = (activation.contactPointsConfig as { contactPoints: Array<Record<string, unknown>> })
      .contactPoints[0];
    expect(point).to.have.property('entityName');
    expect(point).to.have.property('sourcesConfig');
    expect(point.attributesConfig).to.have.property('attributes');
    expect(convertObserved('CalculatedInsight', fixtures.CalculatedInsight).properties.expression).to.include('&lt;');
    expect(convertObserved('CalculatedInsight', fixtures.CalculatedInsight).properties.apiName).to.equal(
      'VehicleHealthScore'
    );
  });
  it('scaffolds offline without a client or authentication and protects outputs', async () => {
    await mkdir(join(dir, 'Connections'));
    await writeFile(
      join(dir, 'Connections', 'connections.json'),
      JSON.stringify({ connections: [fixtures.Connection] })
    );
    const inventory = await offlineInventory(dir);
    const result = await scaffold({
      inventory,
      selectors: ['Connection:connection-record'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(result.report.blockers).to.deep.equal([]);
    expect(result.report.source).to.deep.equal({ mode: 'offline' });
    expect(result.report.limits.join(' ')).to.include('unknown');
    const out = join(dir, 'manifest.json');
    await publishScaffold(result, out);
    let blocked = false;
    try {
      await publishScaffold(result, out);
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
  });
  it('keeps shared dependencies read-only and uses stream dlApiName for mapping references', async () => {
    const inventory: Inventory = {
      items: [
        { type: 'Connection', identity: 'connection-record', observed: fixtures.Connection },
        { type: 'DataStream', identity: 'stream-record', observed: fixtures.DataStream },
        { type: 'DataModelObjectMapping', identity: 'mapping_api', observed: fixtures.DataModelObjectMapping },
        { type: 'DataModelObject', identity: 'ssot__Account__dlm', observed: { name: 'ssot__Account__dlm' } },
      ],
      limits: [],
      source: { mode: 'offline' },
    };
    const result = await scaffold({
      inventory,
      selectors: ['DataStream:stream-record', 'DataModelObjectMapping:mapping_api'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(result.report.blockers).to.deep.equal([]);
    const blocks = result.manifest!.resources;
    expect(blocks.some((b) => b.type === 'DataLakeObject' && b.kind !== 'data')).to.equal(false);
    expect(blocks.find((b) => b.type === 'Connection')!.kind).to.equal('data');
    const mapping = blocks.find((b) => b.type === 'DataModelObjectMapping')!;
    expect(mapping.kind !== 'data' && mapping.properties.sourceEntityDeveloperName).to.equal(
      '${DataStream.stream_api.dlApiName}'
    );
    DependencyGraph.build({ useCase: 'existing', dataSpace: 'default', blocks });
    const other = await scaffold({
      inventory: { ...inventory, items: [...inventory.items].reverse() },
      selectors: ['DataModelObjectMapping:mapping_api', 'DataStream:stream-record'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(manifestBytes(result.manifest!)).to.equal(manifestBytes(other.manifest!));
  });
  it('reports missing, ambiguous, unsupported and unreadable shapes without a manifest', async () => {
    expect(() => parseSelector('bad selector')).to.throw();
    const inventory: Inventory = {
      items: [
        { type: 'Connection', identity: 'a', observed: { name: 'same', connectorType: 'AwsS3' } },
        { type: 'Connection', identity: 'b', observed: { name: 'same' } },
      ],
      limits: [],
      source: { mode: 'offline' },
    };
    const result = await scaffold({
      inventory,
      selectors: ['Connection:same'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(result.manifest).to.equal(undefined);
    expect(result.report.blockers.join()).to.include('ambiguous');
    const unsupported = await scaffold({
      inventory,
      selectors: ['Connection:a'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(unsupported.manifest).to.equal(undefined);
  });
  it('replaces credentials with stable required env references without exposing values', async () => {
    const observed = {
      ...fixtures.Connection,
      credentials: { password: 'private-value', accessToken: 'masked-value' },
    };
    const result = await scaffold({
      inventory: {
        items: [{ type: 'Connection', identity: 'connection-record', observed }],
        limits: [],
        source: { mode: 'offline' },
      },
      selectors: ['Connection:connection-record'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(JSON.stringify(result)).not.to.include('private-value');
    expect(JSON.stringify(result)).not.to.include('masked-value');
    expect(result.report.secretRequirements).to.have.length(2);
  });
  it('round-trips CI scaffold through clean adoption and an unchanged apply with zero outbound mutations', async () => {
    const inventory: Inventory = {
      items: [
        { type: 'CalculatedInsight', identity: 'VehicleHealthScore__cio', observed: fixtures.CalculatedInsight },
        { type: 'DataModelObject', identity: 'ssot__Account__dlm', observed: { name: 'ssot__Account__dlm' } },
      ],
      limits: [],
      source: { mode: 'offline' },
    };
    const result = await scaffold({
      inventory,
      selectors: ['CalculatedInsight:VehicleHealthScore__cio'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(result.report.blockers).to.deep.equal([]);
    const manifest = { useCase: 'existing', dataSpace: 'default', blocks: result.manifest!.resources };
    const graph = DependencyGraph.build(manifest);
    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/ssot__Account__dlm', () => ({
      name: 'ssot__Account__dlm',
      id: 'ssot__Account__dlm',
    }));
    client.on('GET', '/ssot/calculated-insights', () => ({ collection: { items: [fixtures.CalculatedInsight] } }));
    client.on('GET', '/ssot/calculated-insights/VehicleHealthScore__cio', () => fixtures.CalculatedInsight);
    const store = new StateStore(new StatePaths(dir, 'test', 'default'));
    const fingerprint = { orgId: 'test', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' };
    let state = await store.init(fingerprint);
    const plan = await new PlanEngine({ manifest, graph, state, ctx: { client } }).compute();
    expect(plan.adoptionCandidates[0].cleanAdopt).to.equal(true);
    expect((await new ApplyExecutor({ manifest, graph, state, store, plan, ctx: { client } }).run()).failure).to.equal(
      undefined
    );
    state = await store.read(fingerprint);
    const unchanged = await new PlanEngine({ manifest, graph, state, ctx: { client } }).compute();
    expect(unchanged.changes[0].action).to.equal('no-op');
    expect(
      (await new ApplyExecutor({ manifest, graph, state, store, plan: unchanged, ctx: { client } }).run()).failure
    ).to.equal(undefined);
    expect(client.calls.every((r) => r.method === 'GET')).to.equal(true);
  });
  it('round-trips every supported fixture together without dropping resources or mutating during adoption', async () => {
    const observed = Object.fromEntries(
      Object.entries(fixtures).map(([type, value]) => [type, structuredClone(value)])
    );
    const inventory: Inventory = {
      items: Object.entries(observed).map(([type, value]) => ({
        type,
        identity:
          type === 'DataStream'
            ? 'stream-record'
            : type === 'CalculatedInsight'
            ? 'VehicleHealthScore__cio'
            : type === 'DataModelObjectMapping'
            ? 'mapping_api'
            : type === 'AccessPolicyRule'
            ? 'policy_api::' + String(value.name)
            : String(value.id ?? value.name),
        observed: value,
      })),
      limits: [],
      source: { mode: 'offline' },
    };
    const dmos = new Set(['ssot__Account__dlm', 'UnifiedAccount__dlm']);
    const entities = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['entityName', 'contactPointEntityName', 'objectName'].includes(key) && typeof child === 'string')
          dmos.add(child);
        else entities(child);
      }
    };
    entities(observed.IdentityResolutionRuleset);
    entities(observed.Activation);
    for (const name of dmos)
      inventory.items.push({ type: 'DataModelObject', identity: name, observed: { id: name, name } });
    inventory.items.push(
      { type: 'Segment', identity: 'segment-record', observed: { id: 'segment-record', name: 'segment_api' } },
      {
        type: 'ActivationTarget',
        identity: 'target-record',
        observed: { id: 'target-record', name: 'target_api', masterLabel: 'Target' },
      }
    );
    const selectors = inventory.items
      .filter((i) => Object.keys(fixtures).includes(i.type))
      .map((i) => `${i.type}:${i.identity}`);
    const generated = await scaffold({ inventory, selectors, useCase: 'existing', dataSpace: 'default' });
    expect(generated.report.blockers).to.deep.equal([]);
    expect(generated.manifest!.resources.filter((b) => b.kind !== 'data')).to.have.length(Object.keys(fixtures).length);
    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/connections?connectorType=IngestApi&label=Source', () => ({
      connections: [observed.Connection],
    }));
    client.on('GET', '/ssot/data-streams', () => ({ dataStreams: [observed.DataStream] }));
    client.on(
      'GET',
      '/ssot/data-model-object-mappings?dloDeveloperName=source_dlo__dll&dmoDeveloperName=ssot__Account__dlm',
      () => ({ objectSourceTargetMaps: [observed.DataModelObjectMapping] })
    );
    client.on('GET', '/ssot/calculated-insights', () => ({ collection: { items: [observed.CalculatedInsight] } }));
    client.on('GET', '/ssot/identity-resolutions', () => ({
      identityResolutions: [observed.IdentityResolutionRuleset],
    }));
    client.on('GET', '/ssot/activations?filters=name%20in%20activation_api', () => ({
      activations: [observed.Activation],
    }));
    client.on('GET', '/ssot/data-governance/access-policies', () => ({ records: [observed.AccessPolicy] }));
    const ruleName = String(observed.AccessPolicyRule.name);
    client.on(
      'GET',
      '/ssot/data-governance/access-policies/policy_api/rules/' + ruleName,
      () => observed.AccessPolicyRule
    );
    client.on('GET', '/ssot/segments', () => ({
      segments: [{ name: 'segment_api', marketSegmentId: 'segment-record', apiName: 'segment_api' }],
    }));
    client.on('GET', '/ssot/activation-targets?filters=masterLabel%20in%20Target', () => ({
      activationTargets: [{ id: 'target-record', name: 'target_api', masterLabel: 'Target' }],
    }));
    for (const name of dmos) client.on('GET', '/ssot/data-model-objects/' + name, () => ({ id: name, name }));
    const memberPaths: Record<string, string> = {
      Connection: 'connections/connection-record',
      DataStream: 'data-streams/stream-record',
      DataModelObjectMapping: 'data-model-object-mappings/mapping_api',
      CalculatedInsight: 'calculated-insights/VehicleHealthScore__cio',
      IdentityResolutionRuleset: 'identity-resolutions/ruleset-record',
      Activation: 'activations/activation-record',
      AccessPolicy: 'data-governance/access-policies/policy_api',
    };
    for (const [type, path] of Object.entries(memberPaths)) client.on('GET', '/ssot/' + path, () => observed[type]);
    const manifest = { useCase: 'existing', dataSpace: 'default', blocks: generated.manifest!.resources };
    const graph = DependencyGraph.build(manifest);
    const store = new StateStore(new StatePaths(dir, 'test', 'default'));
    const fingerprint = { orgId: 'test', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' };
    let state = await store.init(fingerprint);
    const plan = await new PlanEngine({ manifest, graph, state, ctx: { client } }).compute();
    expect(plan.blockers).to.deep.equal([]);
    expect(
      plan.adoptionCandidates,
      JSON.stringify({ changes: plan.changes, candidates: plan.adoptionCandidates })
    ).to.have.length(Object.keys(fixtures).length);
    expect(plan.adoptionCandidates.every((c) => c.cleanAdopt)).to.equal(true);
    const adopted = await new ApplyExecutor({ manifest, graph, state, store, plan, ctx: { client } }).run();
    expect(adopted.failure, adopted.failure?.error.message).to.equal(undefined);
    state = await store.read(fingerprint);
    const next = await new PlanEngine({ manifest, graph, state, ctx: { client } }).compute();
    expect(next.summary.noOp).to.equal(Object.keys(fixtures).length);
    const unchanged = await new ApplyExecutor({ manifest, graph, state, store, plan: next, ctx: { client } }).run();
    expect(unchanged.failure, unchanged.failure?.error.message).to.equal(undefined);
    expect(client.calls.every((r) => r.method === 'GET')).to.equal(true);
  });
  it('does not infer SQL dependencies from literals or comments and blocks unresolved sources', async () => {
    const observed = {
      ...fixtures.CalculatedInsight,
      expression: "SELECT 'FROM missing__dlm' AS literal /* JOIN missing__dll */",
    };
    const inventory: Inventory = {
      items: [{ type: 'CalculatedInsight', identity: 'VehicleHealthScore__cio', observed }],
      limits: [],
      source: { mode: 'offline' },
    };
    const result = await scaffold({
      inventory,
      selectors: ['CalculatedInsight:VehicleHealthScore__cio'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(result.report.blockers).to.deep.equal([]);
    expect(result.report.references).to.have.length(0);
    const missing = await scaffold({
      inventory: {
        ...inventory,
        items: [{ ...inventory.items[0], observed: { ...observed, expression: 'SELECT x FROM unsupported_source' } }],
      },
      selectors: ['CalculatedInsight:VehicleHealthScore__cio'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(missing.manifest).to.equal(undefined);
  });
  it('allocates collision names independently of inventory order', async () => {
    const items = [
      { type: 'Connection', identity: 'a', observed: { name: 'same-name', label: 'A', connectorType: 'IngestApi' } },
      { type: 'Connection', identity: 'b', observed: { name: 'same_name', label: 'B', connectorType: 'IngestApi' } },
    ];
    const inventory: Inventory = { items, limits: [], source: { mode: 'offline' } };
    const first = await scaffold({
      inventory,
      selectors: ['Connection:a', 'Connection:b'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    const second = await scaffold({
      inventory: { ...inventory, items: [...items].reverse() },
      selectors: ['Connection:b', 'Connection:a'],
      useCase: 'existing',
      dataSpace: 'default',
    });
    expect(first.report.blockers).to.deep.equal([]);
    expect(manifestBytes(first.manifest!)).to.equal(manifestBytes(second.manifest!));
    expect(new Set(first.manifest!.resources.map((b) => b.name)).size).to.equal(2);
  });
  it('reads the existing discover mapping fan-out envelope and readable policy/rule snapshots offline', async () => {
    await mkdir(join(dir, 'Data Model Objects'));
    await mkdir(join(dir, 'Data Governance'));
    await writeFile(
      join(dir, 'Data Model Objects', 'data-model-object-mappings.json'),
      JSON.stringify({ ['ssot__Account__dlm']: { objectSourceTargetMaps: [fixtures.DataModelObjectMapping] } })
    );
    await writeFile(
      join(dir, 'Data Governance', 'access-policies.json'),
      JSON.stringify({ records: [{ ...fixtures.AccessPolicy, rules: [fixtures.AccessPolicyRule] }] })
    );
    const inventory = await offlineInventory(dir);
    expect(inventory.items.some((i) => i.type === 'DataModelObjectMapping' && i.identity === 'mapping_api')).to.equal(
      true
    );
    expect(inventory.items.some((i) => i.type === 'AccessPolicyRule')).to.equal(true);
    expect(inventory.limits.join(' ')).to.include('fan-out');
  });
});
