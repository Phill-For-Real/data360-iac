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
import { expect } from 'chai';
import { loadManifest } from '../../src/manifest/loader.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { emptyState } from '../../src/state/types.js';
import { LoadedManifest } from '../../src/manifest/types.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', 'fixtures', 'asset-maintenance.json');

const FINGERPRINT = {
  orgId: '00Dxx0000000001EAA',
  instanceUrl: 'https://example.my.salesforce.com',
  targetOrgAlias: 'data360-prod',
  dataSpace: 'default',
};

/**
 * Wires every adoption-lookup call the fixture's blocks will make to "nothing found", except
 * for whatever override is supplied. Blocks with no `name`/`apiName`/`label` top-level property
 * (DataModelObjectMapping, Segment) never call lookup() at all. IdentityResolutionRuleset has
 * only `label` -- it does call lookup(), listed below.
 */
function buildEmptyOrgClient(overrides: Record<string, () => unknown> = {}): FakeConnectRestClient {
  const client = new FakeConnectRestClient();
  const defaults: Record<string, () => unknown> = {
    '/ssot/connections?connectorType=IngestApi&label=Account': () => ({ connections: [] }),
    '/ssot/connections?connectorType=IngestApi&label=Vehicle': () => ({ connections: [] }),
    '/ssot/connections?connectorType=IngestApi&label=Vehicle%20Telematics%20Event': () => ({ connections: [] }),
    '/ssot/data-streams': () => ({ dataStreams: [] }),
    '/ssot/data-lake-objects': () => ({ dataLakeObjects: [] }),
    '/ssot/data-model-objects': () => ({
      dataModelObject: [
        { id: 'std-account', name: 'ssot__Account__dlm' },
        { id: 'std-cp-address', name: 'ssot__ContactPointAddress__dlm' },
        { id: 'std-cp-phone', name: 'ssot__ContactPointPhone__dlm' },
        { id: 'std-vehicle', name: 'ssot__Vehicle__dlm' },
        { id: 'std-vte', name: 'ssot__VehicleTelematicsEvent__dlm' },
      ],
    }),
    '/ssot/data-transforms': () => ({ dataTransforms: [] }),
    '/ssot/identity-resolutions': () => ({ identityResolutions: [] }),
    '/ssot/calculated-insights': () => ({ collection: { items: [] } }),
    '/ssot/activation-targets?filters=masterLabel%20in%20fleet_s3_target': () => ({ activationTargets: [] }),
    '/ssot/activation-platforms?activationPlatformView=Developer': () => ({ activationPlatforms: [] }),
    '/ssot/activations?filters=name%20in%20high_risk_vehicles_activation': () => ({ activations: [] }),
    '/ssot/data-governance/access-policies': () => ({ records: [] }),
  };
  for (const [path, handler] of Object.entries({ ...defaults, ...overrides })) {
    client.on('GET', path, handler);
  }
  return client;
}

describe('PlanEngine', () => {
  it('flags an already-existing DataModelObject as an adoption candidate needing an update', async () => {
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'resource',
          type: 'DataModelObject',
          name: 'custom_account_dmo',
          properties: {
            name: 'Custom_Account_DMO',
            label: 'Custom Account',
            dataSpaceName: 'default',
            category: 'PROFILE',
            fields: [
              {
                name: 'CompanyName',
                label: 'Company Name',
                isPrimaryKey: false,
                isDynamicLookup: false,
                dataType: 'Text',
              },
            ],
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);
    const state = emptyState(FINGERPRINT, 'test-lineage');

    // Custom_Account_DMO already exists live, but its fields don't yet include CompanyName.
    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/data-model-objects/Custom_Account_DMO', () => ({
      id: 'existing-account-dmo-id',
      name: 'Custom_Account_DMO',
      category: 'PROFILE',
      dataSpaceName: 'default',
      fields: [],
    }));

    const engine = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan = await engine.compute();

    expect(plan.adoptionCandidates).to.have.lengthOf(1);
    expect(plan.adoptionCandidates[0]).to.include({
      key: 'DataModelObject.custom_account_dmo',
      cleanAdopt: false,
    });
    expect(plan.summary.create).to.equal(0);
  });

  it('flags an already-existing IdentityResolutionRuleset as an adoption candidate by label (it has no apiName/name)', async () => {
    // Regression test: a ruleset's create() call can time out client-side after it actually
    // succeeded server-side (confirmed live) -- without adoption-by-label, the next plan/apply
    // has no way to recognize the already-live ruleset and tries to create a duplicate.
    const manifest: LoadedManifest = {
      useCase: 'uc',
      dataSpace: 'default',
      blocks: [
        {
          kind: 'resource',
          type: 'IdentityResolutionRuleset',
          name: 'account_identity_resolution',
          properties: {
            label: 'Account Identity Resolution',
            configurationType: 'Account',
            matchRules: [],
            reconciliationRules: [],
          },
        },
      ],
    };
    const graph = DependencyGraph.build(manifest);
    const state = emptyState(FINGERPRINT, 'test-lineage');

    const client = new FakeConnectRestClient();
    client.on('GET', '/ssot/identity-resolutions', () => ({
      identityResolutions: [
        {
          id: 'existing-irr-id',
          label: 'Account Identity Resolution',
          configurationType: 'account',
          matchRules: [],
          reconciliationRules: [],
          rulesetStatus: 'PUBLISHED',
        },
      ],
    }));

    const engine = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan = await engine.compute();

    expect(plan.adoptionCandidates).to.have.lengthOf(1);
    expect(plan.adoptionCandidates[0]).to.include({ key: 'IdentityResolutionRuleset.account_identity_resolution' });
    expect(plan.summary.create).to.equal(0);
  });

  it('cascades a downstream warning from a replace-classified change', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);
    const state = emptyState(FINGERPRINT, 'test-lineage');
    state.resources.push({
      kind: 'resource',
      type: 'Connection',
      name: 'account',
      id: 'conn-1',
      propertiesHash: 'sha256:stale',
      dependencies: [],
    });

    const client = buildEmptyOrgClient();
    client.on('GET', '/ssot/connections/conn-1', () => ({ id: 'conn-1', connectorType: 'AwsS3' }));

    const engine = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan = await engine.compute();

    const connectionChange = plan.changes.find((c) => c.key === 'Connection.account');
    expect(connectionChange?.action).to.equal('replace');
    expect(connectionChange?.cascadeWarning).to.include('DataStream.account_stream');
    expect(connectionChange?.cascadeWarning).to.include('DataModelObjectMapping.account_to_account_dmo_mapping');
  });

  it("one resource type's adoption-lookup failing (e.g. a 404 for an endpoint the org doesn't have) is reported as a warning, not a thrown error, and every other resource still plans normally", async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);
    const state = emptyState(FINGERPRINT, 'test-lineage');

    const client = buildEmptyOrgClient({
      '/ssot/data-governance/access-policies': () => {
        throw new Error('FakeConnectRestClient: no handler registered for GET /ssot/data-governance/access-policies');
      },
    });

    const engine = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan = await engine.compute();

    expect(plan.warnings.length).to.be.greaterThan(0);
    expect(plan.warnings.some((w) => w.key === 'AccessPolicy.restrict_sensitive_fields')).to.equal(true);
    expect(plan.blockers?.some((b) => b.key === 'AccessPolicy.restrict_sensitive_fields')).to.equal(true);
    expect(plan.warnings[0].message).to.include('Adoption lookup failed');

    // The failed lookup is still planned as a create -- not silently dropped.
    const accessPolicyChange = plan.changes.find((c) => c.key === 'AccessPolicy.restrict_sensitive_fields');
    expect(accessPolicyChange?.action).to.equal('create');

    // Every other resource plans exactly as if AccessPolicy didn't exist in this manifest.
    const resourceBlockCount = manifest.blocks.filter((b) => (b.kind ?? 'resource') === 'resource').length;
    expect(plan.summary.create).to.equal(resourceBlockCount);
    expect(plan.adoptionCandidates).to.have.lengthOf(0);
  });

  it("a tracked resource's refresh re-GET failing is reported as a warning and leaves that resource no-op rather than forcing a spurious replace", async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);
    const state = emptyState(FINGERPRINT, 'test-lineage');
    state.resources.push({
      kind: 'resource',
      type: 'Connection',
      name: 'account',
      id: 'conn-1',
      propertiesHash: 'sha256:matches-current-manifest',
      dependencies: [],
    });

    const client = buildEmptyOrgClient();
    client.on('GET', '/ssot/connections/conn-1', () => {
      throw new Error('FakeConnectRestClient: no handler registered for GET /ssot/connections/conn-1');
    });

    const engine = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan = await engine.compute();

    expect(plan.warnings.length).to.be.greaterThan(0);
    expect(plan.warnings[0]).to.include({ key: 'Connection.account' });

    const connectionChange = plan.changes.find((c) => c.key === 'Connection.account');
    expect(connectionChange?.action).to.equal('no-op');
  });
});
