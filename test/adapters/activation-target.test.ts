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
import { ActivationTargetAdapter } from '../../src/adapters/activation-target.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('ActivationTargetAdapter', () => {
  it('creates the simple connector-style resource via /ssot/activation-targets', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationTargetAdapter();
    client.on('POST', '/ssot/activation-targets', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'target-1',
      status: 'ACTIVE',
    }));

    const result = await adapter.create(
      { client },
      { dataSpaceName: 'default', name: 'fleet_s3_target', platformType: 'AmazonS3', connector: {} }
    );

    expect(result?.id).to.equal('target-1');
    expect(result?.properties.status).to.equal('ACTIVE');
    expect('waitForCompletion' in adapter).to.equal(false);
  });

  it('lookup() filters by masterLabel', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationTargetAdapter();
    client.on('GET', '/ssot/activation-targets?filters=masterLabel%20in%20fleet_s3_target', () => ({
      activationTargets: [{ id: 'target-1', name: 'fleet_s3_target' }],
    }));

    const result = await adapter.lookup({ client }, { name: 'fleet_s3_target' });

    expect(result?.id).to.equal('target-1');
  });
});
