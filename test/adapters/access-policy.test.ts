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
import { AccessPolicyAdapter } from '../../src/adapters/access-policy.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('AccessPolicyAdapter', () => {
  it('creates a policy and uses the client-supplied name as both id and apiName', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyAdapter();
    client.on('POST', '/ssot/data-governance/access-policies', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: '0hpxx0000000001AAA',
      builderCompatible: true,
    }));

    const result = await adapter.create(
      { client },
      { name: 'RestrictSensitiveFields', label: 'Restrict Sensitive Fields', description: 'Masks sensitive fields.' }
    );

    expect(result?.id).to.equal('RestrictSensitiveFields');
    expect(result?.apiName).to.equal('RestrictSensitiveFields');
  });

  it('updates label/description via PATCH to the real member path', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyAdapter();
    client.on('PATCH', '/ssot/data-governance/access-policies/RestrictSensitiveFields', (req) => ({
      name: 'RestrictSensitiveFields',
      ...(req.body as Record<string, unknown>),
    }));

    await adapter.update({ client }, 'RestrictSensitiveFields', { label: 'Regional Masking Updated' });

    expect(client.calls[0]).to.deep.equal({
      method: 'PATCH',
      path: '/ssot/data-governance/access-policies/RestrictSensitiveFields',
      body: { label: 'Regional Masking Updated' },
    });
  });

  it('classifies name as replace and label/description as update', () => {
    const adapter = new AccessPolicyAdapter();
    expect(adapter.fieldClassification.name).to.equal('replace');
    expect(adapter.fieldClassification.label).to.equal('update');
    expect(adapter.fieldClassification.description).to.equal('update');
  });
});
