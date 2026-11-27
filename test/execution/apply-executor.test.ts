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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { loadManifest } from '../../src/manifest/loader.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { ApplyExecutor } from '../../src/execution/apply-executor.js';
import { computePropertiesHash } from '../../src/plan/properties-hash.js';
import { StatePaths } from '../../src/state/paths.js';
import { StateStore } from '../../src/state/store.js';
import { OrgFingerprint } from '../../src/state/types.js';
import { LoadedManifest } from '../../src/manifest/types.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { buildFakeOrg, FailureToggle } from '../support/fake-org-builder.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', 'fixtures', 'asset-maintenance.json');

const FINGERPRINT: OrgFingerprint = {
  orgId: '00Dxx0000000001EAA',
  instanceUrl: 'https://example.my.salesforce.com',
  targetOrgAlias: 'data360-prod',
  dataSpace: 'default',
};

describe('ApplyExecutor', () => {
  let dir: string;
  const originalSecretEnvValue = process.env.FLEET_S3_SECRET_ACCESS_KEY;
  const originalAccessKeyIdEnvValue = process.env.FLEET_S3_ACCESS_KEY_ID;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-apply-'));
    // The fixture manifest references these via $secret; ApplyExecutor resolves them at apply time.
    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'test-secret-value';
    process.env.FLEET_S3_ACCESS_KEY_ID = 'test-access-key-id';
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (originalSecretEnvValue === undefined) {
      delete process.env.FLEET_S3_SECRET_ACCESS_KEY;
    } else {
      process.env.FLEET_S3_SECRET_ACCESS_KEY = originalSecretEnvValue;
    }
    if (originalAccessKeyIdEnvValue === undefined) {
      delete process.env.FLEET_S3_ACCESS_KEY_ID;
    } else {
      process.env.FLEET_S3_ACCESS_KEY_ID = originalAccessKeyIdEnvValue;
    }
  });

  it('applies the full Asset Maintenance manifest end to end, pausing between stages with --step', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = buildFakeOrg(manifest);
    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();
    expect(plan.summary.create).to.equal(26);

    const stagesCompleted: string[] = [];
    const executor = new ApplyExecutor({
      manifest,
      graph,
      plan,
      state: initialState,
      store,
      ctx: { client },
      step: true,
      onStageComplete: async (stageName) => {
        stagesCompleted.push(stageName);
        return true;
      },
    });

    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    expect(result.completed).to.have.lengthOf(26);
    expect(stagesCompleted).to.deep.equal([
      'Connections',
      'Ingestion',
      'Data Model',
      'Intelligence',
      'Governance',
      'Segmentation',
      'Activation',
    ]);

    const finalState = await store.read(FINGERPRINT);
    expect(finalState.resources).to.have.lengthOf(26);
    expect(finalState.resources.every((r) => Boolean(r.id))).to.equal(true);
  });

  it('halts on a mid-stage failure, leaving earlier stages correctly reflected in state, and resumes cleanly', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    // Make the CalculatedInsight's run-action poll fail partway through Stage 4.
    const failureToggle: FailureToggle = { failType: 'CalculatedInsight' };
    const client = buildFakeOrg(manifest, failureToggle);
    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();

    const executor = new ApplyExecutor({ manifest, graph, plan, state: initialState, store, ctx: { client } });
    const firstRun = await executor.run();

    expect(firstRun.failure).to.exist;
    expect(firstRun.failure?.key).to.equal('CalculatedInsight.vehicle_health_score_ci');

    let stateAfterFailure = await store.read(FINGERPRINT);
    const completedTypes = new Set(stateAfterFailure.resources.map((r) => r.type));
    expect(completedTypes.has('Connection')).to.equal(true);
    expect(completedTypes.has('DataStream')).to.equal(true);
    expect(completedTypes.has('DataModelObjectMapping')).to.equal(true);
    const pendingInsight = stateAfterFailure.resources.find((r) => r.type === 'CalculatedInsight');
    expect(pendingInsight?.lifecyclePending).to.equal('ready');
    expect(pendingInsight?.lastAppliedAt).to.be.undefined;

    // Fix the failure (same org/client, the transient problem is now resolved) and re-run:
    // resume should not redo completed work or error on resources it already knows about.
    failureToggle.failType = undefined;
    const engine2 = new PlanEngine({ manifest, graph, state: stateAfterFailure, ctx: { client } });
    const plan2 = await engine2.compute();
    const executor2 = new ApplyExecutor({
      manifest,
      graph,
      plan: plan2,
      state: stateAfterFailure,
      store,
      ctx: { client },
    });
    const secondRun = await executor2.run();

    expect(secondRun.failure).to.be.undefined;
    expect(
      client.calls.filter((request) => request.method === 'POST' && request.path === '/ssot/calculated-insights')
    ).to.have.length(1);

    stateAfterFailure = await store.read(FINGERPRINT);
    expect(
      stateAfterFailure.resources,
      JSON.stringify({
        summary: plan2.summary,
        changes: plan2.changes,
        adopted: plan2.adoptionCandidates,
        completed: secondRun.completed,
      })
    ).to.have.lengthOf(26);
  });

  it('resolves a kind: "data" block\'s lookup before applying a resource that references it', async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'data',
          type: 'DataModelObject',
          name: 'existing_account_dmo',
          lookup: { name: 'Account_DMO__dlm' },
        },
        {
          kind: 'resource',
          type: 'Segment',
          name: 'vip_customers_segment',
          properties: {
            displayName: 'VIP Customers',
            segmentOnApiName: '${DataModelObject.existing_account_dmo.apiName}',
            segmentType: 'UI',
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/Account_DMO__dlm', () => ({
      id: 'dmo-existing-1',
      name: 'Account_DMO__dlm',
    }));
    client.on('GET', '/ssot/segments', () => ({ segments: [] }));
    client.on('POST', '/ssot/segments', (req) => ({
      ...(req.body as Record<string, unknown>),
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
    }));
    client.on('POST', '/ssot/segments/seg-1/actions/publish', () => ({}));
    client.on('GET', '/ssot/segments/seg-1', () => ({
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
      segmentStatus: 'ACTIVE',
    }));

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();
    expect(plan.summary.create).to.equal(1);

    const executor = new ApplyExecutor({ manifest, graph, plan, state: initialState, store, ctx: { client } });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    expect(result.completed).to.deep.equal(['Segment.vip_customers_segment']);

    const segmentCreateCall = client.calls.find((c) => c.method === 'POST' && c.path === '/ssot/segments');
    expect((segmentCreateCall?.body as { segmentOnApiName: string }).segmentOnApiName).to.equal('Account_DMO__dlm');
  });

  it('reports onProgress events for the stage, the resource, its async-job wait, and completion', async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'data',
          type: 'DataModelObject',
          name: 'existing_account_dmo',
          lookup: { name: 'Account_DMO__dlm' },
        },
        {
          kind: 'resource',
          type: 'Segment',
          name: 'vip_customers_segment',
          properties: {
            displayName: 'VIP Customers',
            segmentOnApiName: '${DataModelObject.existing_account_dmo.apiName}',
            segmentType: 'UI',
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/Account_DMO__dlm', () => ({
      id: 'dmo-existing-1',
      name: 'Account_DMO__dlm',
    }));
    client.on('GET', '/ssot/segments', () => ({ segments: [] }));
    client.on('POST', '/ssot/segments', (req) => ({
      ...(req.body as Record<string, unknown>),
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
    }));
    client.on('POST', '/ssot/segments/seg-1/actions/publish', () => ({}));
    client.on('GET', '/ssot/segments/seg-1', () => ({
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
      segmentStatus: 'ACTIVE',
    }));

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();

    const events: string[] = [];
    const executor = new ApplyExecutor({
      manifest,
      graph,
      plan,
      state: initialState,
      store,
      ctx: { client },
      onProgress: (event) => events.push(event.type),
    });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    expect(events).to.deep.equal(['stage-start', 'resource-start', 'resource-waiting-job', 'resource-done']);
  });

  it('reports a resource-job-status event only when the status changes (deduplicating repeats)', async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'data',
          type: 'DataModelObject',
          name: 'existing_account_dmo',
          lookup: { name: 'Account_DMO__dlm' },
        },
        {
          kind: 'resource',
          type: 'Segment',
          name: 'vip_customers_segment',
          properties: {
            displayName: 'VIP Customers',
            segmentOnApiName: '${DataModelObject.existing_account_dmo.apiName}',
            segmentType: 'UI',
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/Account_DMO__dlm', () => ({
      id: 'dmo-existing-1',
      name: 'Account_DMO__dlm',
    }));
    client.on('GET', '/ssot/segments', () => ({ segments: [] }));
    client.on('POST', '/ssot/segments', (req) => ({
      ...(req.body as Record<string, unknown>),
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
    }));
    client.on('POST', '/ssot/segments/seg-1/actions/publish', () => ({}));
    let pollCount = 0;
    client.on('GET', '/ssot/segments/seg-1', () => {
      pollCount += 1;
      let segmentStatus: string;
      if (pollCount <= 2) segmentStatus = 'PROCESSING';
      else if (pollCount <= 4) segmentStatus = 'QUALIFYING';
      else segmentStatus = 'ACTIVE';
      // Repeats the same non-terminal status twice before transitioning, then repeats the next
      // status twice too -- simulates a genuinely long-running job, per product guidance: poll
      // on a fixed interval, but only surface a change, not every identical repeat.
      return { marketSegmentId: 'seg-1', apiName: 'vip_customers_segment', segmentStatus };
    });

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();

    const jobStatusEvents: Array<string | undefined> = [];
    const executor = new ApplyExecutor({
      manifest,
      graph,
      plan,
      state: initialState,
      store,
      ctx: { client },
      onProgress: (event) => {
        if (event.type === 'resource-job-status') jobStatusEvents.push(event.status);
      },
    });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    expect(jobStatusEvents).to.deep.equal(['PROCESSING', 'QUALIFYING']);
  });

  it('reports a resource-job-status event even when the status is undefined on every poll (regression: undefined must not match the dedup sentinel)', async () => {
    // Regression test: the dedup check used to compare against a `string | undefined` variable
    // initialized to `undefined`. A job whose status field genuinely resolves to `undefined` on
    // every poll (e.g. a field-path mismatch, or a resource type whose status field is absent
    // until some condition) would then have its first `undefined` poll match that initial
    // sentinel and suppress every single progress event for the rest of the run -- silent, with
    // no way to tell the job apart from one that's simply slow, confirmed to manifest live as an
    // apply that silently waits out the full polling timeout with zero progress output.
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'data',
          type: 'DataModelObject',
          name: 'existing_account_dmo',
          lookup: { name: 'Account_DMO__dlm' },
        },
        {
          kind: 'resource',
          type: 'Segment',
          name: 'vip_customers_segment',
          properties: {
            displayName: 'VIP Customers',
            segmentOnApiName: '${DataModelObject.existing_account_dmo.apiName}',
            segmentType: 'UI',
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/Account_DMO__dlm', () => ({
      id: 'dmo-existing-1',
      name: 'Account_DMO__dlm',
    }));
    client.on('GET', '/ssot/segments', () => ({ segments: [] }));
    client.on('POST', '/ssot/segments', (req) => ({
      ...(req.body as Record<string, unknown>),
      marketSegmentId: 'seg-1',
      apiName: 'vip_customers_segment',
    }));
    client.on('POST', '/ssot/segments/seg-1/actions/publish', () => ({}));
    let pollCount = 0;
    client.on('GET', '/ssot/segments/seg-1', () => {
      pollCount += 1;
      // segmentStatus is undefined on every poll but the last -- simulates a status field that
      // never resolves until the job actually finishes.
      if (pollCount < 3) return { marketSegmentId: 'seg-1', apiName: 'vip_customers_segment' };
      return { marketSegmentId: 'seg-1', apiName: 'vip_customers_segment', segmentStatus: 'ACTIVE' };
    });

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();

    const jobStatusEvents: Array<string | undefined> = [];
    const executor = new ApplyExecutor({
      manifest,
      graph,
      plan,
      state: initialState,
      store,
      ctx: { client },
      onProgress: (event) => {
        if (event.type === 'resource-job-status') jobStatusEvents.push(event.status);
      },
    });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    // Must log the undefined status at least once -- proving onPoll's output actually reached
    // the progress stream instead of being silently swallowed by the dedup check.
    expect(jobStatusEvents).to.deep.equal([undefined]);
  });

  it("threads a resource's full output (not just {id, apiName}) from create into a downstream create in the same run", async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'resource',
          type: 'DataStream',
          name: 'account_stream',
          properties: { name: 'account_stream', connectionId: 'conn-1' },
        },
        {
          kind: 'resource',
          type: 'DataModelObjectMapping',
          name: 'account_mapping',
          dependsOn: ['DataStream.account_stream'],
          properties: {
            sourceEntityDeveloperName: '${DataStream.account_stream.dlApiName}',
            targetEntityDeveloperName: 'Account_DMO__dlm',
            fieldMapping: [],
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-streams', () => ({ dataStreams: [] }));
    client.on('POST', '/ssot/data-streams', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'stream-1',
      recordId: 'record-1',
      name: 'account_stream',
      dataLakeObjectInfo: { name: 'Account_account_dlo_EFB60999' },
    }));
    client.on(
      'GET',
      '/ssot/data-model-object-mappings?dloDeveloperName=Account_account_dlo_EFB60999&dmoDeveloperName=Account_DMO__dlm',
      () => ({ objectSourceTargetMaps: [] })
    );
    client.on('POST', '/ssot/data-model-object-mappings?dataspace=default', (req) => ({
      ...(req.body as Record<string, unknown>),
      developerName: 'account_mapping',
    }));

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();
    expect(plan.summary.create).to.equal(2);

    const executor = new ApplyExecutor({ manifest, graph, plan, state: initialState, store, ctx: { client } });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    const mappingCreateCall = client.calls.find(
      (c) => c.method === 'POST' && c.path === '/ssot/data-model-object-mappings?dataspace=default'
    );
    expect((mappingCreateCall?.body as { sourceEntityDeveloperName: string }).sourceEntityDeveloperName).to.equal(
      'Account_account_dlo_EFB60999'
    );
  });

  it("threads a no-op resource's full live output (not just {id, apiName}) into a downstream create", async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'resource',
          type: 'DataStream',
          name: 'account_stream',
          properties: { name: 'account_stream', connectionId: 'conn-1' },
        },
        {
          kind: 'resource',
          type: 'DataModelObjectMapping',
          name: 'account_mapping',
          dependsOn: ['DataStream.account_stream'],
          properties: {
            sourceEntityDeveloperName: '${DataStream.account_stream.dlApiName}',
            targetEntityDeveloperName: 'Account_DMO__dlm',
            fieldMapping: [],
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    // account_stream is already tracked in state (as if applied in a prior run) and will plan as
    // no-op below -- buildWorkItems() never builds a WorkItem for it, so its full adapter output
    // (dlApiName) must come from the new refreshNoOpOutputs() live-read step, not from the
    // {id, apiName}-only seed the constructor takes from state.
    const initialState = await store.init(FINGERPRINT);
    initialState.resources.push({
      kind: 'resource',
      type: 'DataStream',
      name: 'account_stream',
      id: 'record-1',
      propertiesHash: computePropertiesHash({ name: 'account_stream', connectionId: 'conn-1' }),
      dependencies: [],
    });

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-streams/record-1', () => ({
      id: 'record-1',
      recordId: 'record-1',
      name: 'account_stream',
      dataLakeObjectInfo: { name: 'Account_account_dlo_EFB60999' },
    }));
    client.on(
      'GET',
      '/ssot/data-model-object-mappings?dloDeveloperName=Account_account_dlo_EFB60999&dmoDeveloperName=Account_DMO__dlm',
      () => ({ objectSourceTargetMaps: [] })
    );
    client.on('POST', '/ssot/data-model-object-mappings?dataspace=default', (req) => ({
      ...(req.body as Record<string, unknown>),
      developerName: 'account_mapping',
    }));

    const engine = new PlanEngine({ manifest, graph, state: initialState, ctx: { client } });
    const plan = await engine.compute();
    expect(plan.changes.find((c) => c.key === 'DataStream.account_stream')?.action).to.equal('no-op');

    const executor = new ApplyExecutor({ manifest, graph, plan, state: initialState, store, ctx: { client } });
    const result = await executor.run();

    expect(result.failure, result.failure?.error.message).to.be.undefined;
    const mappingCreateCall = client.calls.find(
      (c) => c.method === 'POST' && c.path === '/ssot/data-model-object-mappings?dataspace=default'
    );
    expect((mappingCreateCall?.body as { sourceEntityDeveloperName: string }).sourceEntityDeveloperName).to.equal(
      'Account_account_dlo_EFB60999'
    );
  });

  it("fails clearly when a data block's lookup finds nothing live", async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'data',
          type: 'DataModelObject',
          name: 'missing_dmo',
          lookup: { name: 'DoesNotExist__dlm' },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);

    const paths = new StatePaths(dir, 'data360-prod', 'default');
    const store = new StateStore(paths);
    const initialState = await store.init(FINGERPRINT);

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/DoesNotExist__dlm', () => null);

    const plan = {
      changes: [],
      adoptionCandidates: [],
      destroys: [],
      warnings: [],
      summary: { create: 0, update: 0, replace: 0, destroy: 0, noOp: 0, total: 0 },
    };

    const executor = new ApplyExecutor({ manifest, graph, plan, state: initialState, store, ctx: { client } });

    try {
      await executor.run();
      expect.fail('expected run to throw');
    } catch (e) {
      expect((e as Error).message).to.include('DataModelObject.missing_dmo');
      expect((e as Error).message).to.include('could not be resolved');
    }
  });
});
