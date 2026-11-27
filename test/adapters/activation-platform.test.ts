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
import { ActivationPlatformAdapter } from '../../src/adapters/activation-platform.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('ActivationPlatformAdapter', () => {
  it('creates the full-featured resource, passing the body through untouched', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationPlatformAdapter();
    const body = {
      name: 'field_service_platform',
      platformType: 'Advertising',
      activationPlatformAttributes: [{ name: 'AssetId', isIdentifier: true }],
    };
    client.on('POST', '/ssot/activation-platforms', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'plat-1',
    }));

    const result = await adapter.create({ client }, body);

    expect(result?.id).to.equal('plat-1');
    expect(result?.properties.activationPlatformAttributes).to.deep.equal(body.activationPlatformAttributes);
  });

  it('lookup() requests the Developer view', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationPlatformAdapter();
    client.on('GET', '/ssot/activation-platforms?activationPlatformView=Developer', () => ({
      activationPlatforms: [{ id: 'plat-1', name: 'field_service_platform' }],
    }));

    const result = await adapter.lookup({ client }, { name: 'field_service_platform' });

    expect(result?.id).to.equal('plat-1');
  });
});
