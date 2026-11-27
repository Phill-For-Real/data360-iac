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
import { AccessPolicyRuleAdapter } from '../../src/adapters/access-policy-rule.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('AccessPolicyRuleAdapter', () => {
  it('create() PUTs to the policy-scoped rule path, stripping policyName out of the body', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyRuleAdapter();
    client.on('PUT', '/ssot/data-governance/access-policies/RestrictSensitiveFields/rules/Mask_SSN', (req) => ({
      id: '0hsxx0000000001AAA',
      ...(req.body as Record<string, unknown>),
    }));

    const result = await adapter.create(
      { client },
      {
        policyName: 'RestrictSensitiveFields',
        name: 'Mask_SSN',
        label: 'Mask SSN',
        category: 'TRANSFORM_POLICY_RULE_DEFINITION',
        effect: 'Transform',
        action: ['Read'],
        resourceScopeType: 'FIELD',
        principalScopeType: 'ANY',
        resourceDomains: ['Account__dlm'],
        resourceTransform: 'FIRST_N_CHARS_RESOURCE_TRANSFORM',
      }
    );

    expect(result?.id).to.equal('RestrictSensitiveFields::Mask_SSN');
    expect(client.calls[0].body).to.not.have.property('policyName');
    expect((client.calls[0].body as Record<string, unknown>).name).to.equal('Mask_SSN');
  });

  it('update() PUTs to the same upsert path (create and update are the same call)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyRuleAdapter();
    client.on('PUT', '/ssot/data-governance/access-policies/RestrictSensitiveFields/rules/Mask_SSN', (req) => ({
      id: '0hsxx0000000001AAA',
      ...(req.body as Record<string, unknown>),
    }));

    client.on('GET', '/ssot/data-governance/access-policies/RestrictSensitiveFields/rules/Mask_SSN', () => ({
      name: 'Mask_SSN',
      category: 'TRANSFORM_POLICY_RULE_DEFINITION',
      effect: 'Transform',
      action: ['Read'],
      resourceScopeType: 'FIELD',
      principalScopeType: 'ANY',
      ruleConsumer: 'Data360',
    }));
    const result = await adapter.update({ client }, 'RestrictSensitiveFields::Mask_SSN', {
      policyName: 'RestrictSensitiveFields',
      name: 'Mask_SSN',
      transformPrecedence: 200,
    });

    expect(result?.id).to.equal('RestrictSensitiveFields::Mask_SSN');
    expect(client.calls.find((request) => request.method === 'PUT')!.body).to.not.have.property('policyName');
  });

  it('read() decodes the composite id back into the real policy/rule path', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyRuleAdapter();
    client.on('GET', '/ssot/data-governance/access-policies/RestrictSensitiveFields/rules/Mask_SSN', () => ({
      name: 'Mask_SSN',
    }));

    const result = await adapter.read({ client }, 'RestrictSensitiveFields::Mask_SSN');

    expect(result?.id).to.equal('RestrictSensitiveFields::Mask_SSN');
  });

  it('delete() rejects unsupported standalone deletion without any request', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new AccessPolicyRuleAdapter();

    let rejected = false;
    try {
      await adapter.delete({ client }, 'RestrictSensitiveFields::Mask_SSN');
    } catch (error) {
      rejected = true;
      expect((error as Error).name).to.equal('UNSUPPORTED_DELETE');
    }
    expect(rejected).to.equal(true);

    expect(client.calls).to.have.lengthOf(0);
  });

  it('classifies name/category/resourceScopeType as replace, the rest as update', () => {
    const adapter = new AccessPolicyRuleAdapter();
    expect(adapter.fieldClassification.name).to.equal('replace');
    expect(adapter.fieldClassification.category).to.equal('replace');
    expect(adapter.fieldClassification.resourceScopeType).to.equal('replace');
    expect(adapter.fieldClassification.effect).to.equal('update');
    expect(adapter.fieldClassification.resourceDomains).to.equal('update');
  });
});
