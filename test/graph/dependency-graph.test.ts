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
import { ManifestValidationError } from '../../src/manifest/errors.js';
import { LoadedManifest } from '../../src/manifest/types.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', 'fixtures', 'asset-maintenance.json');

function manifestFrom(blocks: LoadedManifest['blocks']): LoadedManifest {
  return { useCase: 'uc', dataSpace: 'default', blocks };
}

describe('DependencyGraph', () => {
  it('builds the expected 31-node graph with edges matching the Asset Maintenance manifest', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);

    expect(graph.getNodes()).to.have.lengthOf(31);

    expect(graph.getDependencies('DataStream.account_stream')).to.include('Connection.account');
    expect(graph.getDependencies('DataModelObjectMapping.account_to_account_dmo_mapping')).to.include.members([
      'DataStream.account_stream',
      'DataModelObject.ssot_account_dmo',
    ]);
    // The DataTransform's output DLO is referenced by name (${DataLakeObject.x.apiName}) inside
    // its definition.nodes.OUTPUT0.parameters.name, not a top-level property -- confirms
    // findReferences' recursive traversal picks up nested ${Type.name.field} tokens too.
    expect(graph.getDependencies('DataTransform.vehicle_maintenance_enrichment_transform')).to.include.members([
      'DataStream.vehicle_stream',
      'DataLakeObject.vehicle_maintenance_enrichment_dlo',
    ]);
    expect(graph.getDependencies('IdentityResolutionRuleset.account_identity_resolution')).to.include(
      'DataModelObject.ssot_account_dmo'
    );
    expect(graph.getDependencies('Segment.high_risk_vehicles_segment')).to.include('DataModelObject.ssot_vehicle_dmo');
    expect(graph.getDependencies('Activation.high_risk_vehicles_activation')).to.include.members([
      'Segment.high_risk_vehicles_segment',
      'ActivationTarget.fleet_s3_activation_target',
      'DataModelObject.ssot_vehicle_dmo',
    ]);
  });

  it('merges an explicit dependsOn entry alongside literal-reference edges', () => {
    const manifest = manifestFrom([
      { kind: 'resource', type: 'Connection', name: 'a', properties: {} },
      {
        kind: 'resource',
        type: 'Segment',
        name: 'b',
        properties: {},
        dependsOn: ['Connection.a'],
      },
    ]);
    const graph = DependencyGraph.build(manifest);
    expect(graph.getDependencies('Segment.b')).to.deep.equal(['Connection.a']);
  });

  it('fails on a cyclic reference', () => {
    const manifest = manifestFrom([
      {
        kind: 'resource',
        type: 'Segment',
        name: 'a',
        properties: { ref: '${Segment.b.id}' },
      },
      {
        kind: 'resource',
        type: 'Segment',
        name: 'b',
        properties: { ref: '${Segment.a.id}' },
      },
    ]);

    expect(() => DependencyGraph.build(manifest)).to.throw(ManifestValidationError, /Cycle detected/);
  });

  it('fails on a reference to a nonexistent block', () => {
    const manifest = manifestFrom([
      {
        kind: 'resource',
        type: 'Segment',
        name: 'a',
        properties: { ref: '${Connection.missing.id}' },
      },
    ]);

    expect(() => DependencyGraph.build(manifest)).to.throw(ManifestValidationError, /not declared/);
  });

  it('fails on a duplicate logical name within the same kind', () => {
    const manifest = manifestFrom([
      { kind: 'resource', type: 'Connection', name: 'dup', properties: {} },
      { kind: 'resource', type: 'Connection', name: 'dup', properties: {} },
    ]);

    expect(() => DependencyGraph.build(manifest)).to.throw(ManifestValidationError, /Duplicate logical name/);
  });

  it('produces a topological order where every dependency precedes its dependents', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    const graph = DependencyGraph.build(manifest);
    const order = graph.topologicalOrder();
    const indexOf = (key: string): number => order.indexOf(key);

    expect(indexOf('Connection.account')).to.be.lessThan(indexOf('DataStream.account_stream'));
    expect(indexOf('DataStream.account_stream')).to.be.lessThan(
      indexOf('DataModelObjectMapping.account_to_account_dmo_mapping')
    );
    expect(indexOf('DataModelObject.ssot_account_dmo')).to.be.lessThan(
      indexOf('DataModelObjectMapping.account_to_account_dmo_mapping')
    );
    expect(indexOf('Segment.high_risk_vehicles_segment')).to.be.lessThan(
      indexOf('Activation.high_risk_vehicles_activation')
    );
  });
});
