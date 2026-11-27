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
import { ObjectAccessGrantAdapter } from '../../src/adapters/object-access-grant.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('ObjectAccessGrantAdapter', () => {
  it('creates a grant and synthesizes a composite id from the real id-less response', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ObjectAccessGrantAdapter();
    client.on('POST', '/ssot/data-governance/object-access-grants', (req) => ({
      ...(req.body as Record<string, unknown>),
    }));

    const result = await adapter.create(
      { client },
      { objectApiName: 'Account__dlm', permissionSetName: 'DC_Analyst_PermSet', dataSpaceName: 'default' }
    );

    expect(result?.id).to.equal('Account__dlm::DC_Analyst_PermSet::default');
    expect(result?.apiName).to.equal('Account__dlm::DC_Analyst_PermSet::default');
  });

  it('defaults the synthesized id to dataSpaceName "default" when the response omits it', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ObjectAccessGrantAdapter();
    client.on('POST', '/ssot/data-governance/object-access-grants', () => ({
      objectApiName: 'Account__dlm',
      permissionSetName: 'DC_Analyst_PermSet',
    }));

    const result = await adapter.create(
      { client },
      { objectApiName: 'Account__dlm', permissionSetName: 'DC_Analyst_PermSet' }
    );

    expect(result?.id).to.equal('Account__dlm::DC_Analyst_PermSet::default');
  });

  it('read() and delete() decode the composite id back into the real objectApiName path + query params', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ObjectAccessGrantAdapter();
    client.on(
      'GET',
      '/ssot/data-governance/object-access-grants/Account__dlm?permissionSetName=DC_Analyst_PermSet&dataSpaceName=default',
      () => ({ objectApiName: 'Account__dlm', permissionSetName: 'DC_Analyst_PermSet', dataSpaceName: 'default' })
    );
    client.on(
      'DELETE',
      '/ssot/data-governance/object-access-grants/Account__dlm?permissionSetName=DC_Analyst_PermSet&dataSpaceName=default',
      () => ({})
    );

    const result = await adapter.read({ client }, 'Account__dlm::DC_Analyst_PermSet::default');
    await adapter.delete({ client }, 'Account__dlm::DC_Analyst_PermSet::default');

    expect(result?.id).to.equal('Account__dlm::DC_Analyst_PermSet::default');
  });

  it('classifies all three fields as replace -- no PATCH endpoint exists', () => {
    const adapter = new ObjectAccessGrantAdapter();
    expect(adapter.fieldClassification.objectApiName).to.equal('replace');
    expect(adapter.fieldClassification.permissionSetName).to.equal('replace');
    expect(adapter.fieldClassification.dataSpaceName).to.equal('replace');
  });
});
