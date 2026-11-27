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
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { emptyState } from '../../src/state/types.js';
import { LoadedManifest, ResourceBlock } from '../../src/manifest/types.js';
import { computePropertiesHash } from '../../src/plan/properties-hash.js';
import { stripSecrets } from '../../src/plan/strip-secrets.js';

const FINGERPRINT = {
  orgId: '00Dxx0000000001EAA',
  instanceUrl: 'https://example.my.salesforce.com',
  targetOrgAlias: 'data360-prod',
  dataSpace: 'default',
};

function connectionManifest(): LoadedManifest {
  return {
    useCase: 'uc',
    dataSpace: 'default',
    blocks: [
      {
        kind: 'resource',
        type: 'Connection',
        name: 'fleet_telematics_connection',
        properties: {
          connectorType: 'S3',
          authProperties: {
            accessKeyId: 'AKIA123',
            secretAccessKey: { $secret: { source: 'env', key: 'FLEET_S3_SECRET_ACCESS_KEY' } },
          },
        },
      },
    ],
  };
}

describe('plan vs. $secret drift', () => {
  const originalEnvValue = process.env.FLEET_S3_SECRET_ACCESS_KEY;

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.FLEET_S3_SECRET_ACCESS_KEY;
    } else {
      process.env.FLEET_S3_SECRET_ACCESS_KEY = originalEnvValue;
    }
  });

  it('does not register a changed $secret-referenced env var as drift between two plan runs', async () => {
    const manifest = connectionManifest();
    const graph = DependencyGraph.build(manifest);
    const client = new FakeConnectRestClient();
    const block = manifest.blocks[0] as ResourceBlock;

    const state = emptyState(FINGERPRINT, 'test-lineage');
    state.resources.push({
      kind: 'resource',
      type: 'Connection',
      name: 'fleet_telematics_connection',
      id: 'conn-1',
      propertiesHash: computePropertiesHash(stripSecrets(block.properties) as Record<string, unknown>),
      dependencies: [],
    });

    client.on('GET', '/ssot/connections/conn-1', () => ({
      id: 'conn-1',
      connectorType: 'S3',
      authProperties: { accessKeyId: 'AKIA123', secretAccessKey: '*****' },
    }));

    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'first-value';
    const engine1 = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan1 = await engine1.compute();
    expect(plan1.summary.noOp).to.equal(1);
    expect(plan1.summary.update).to.equal(0);
    expect(plan1.summary.replace).to.equal(0);

    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'second-value';
    const engine2 = new PlanEngine({ manifest, graph, state, ctx: { client } });
    const plan2 = await engine2.compute();
    expect(plan2.summary.noOp).to.equal(1);
    expect(plan2.summary.update).to.equal(0);
    expect(plan2.summary.replace).to.equal(0);
  });
});
