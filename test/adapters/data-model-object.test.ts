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
import { DataModelObjectAdapter } from '../../src/adapters/data-model-object.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('DataModelObjectAdapter', () => {
  it('creates a DMO with no fieldMappings property anywhere', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectAdapter();
    client.on('POST', '/ssot/data-model-objects', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'dmo-1',
      name: 'Account_DMO__dlm',
    }));

    const result = await adapter.create({ client }, { name: 'Account_DMO', category: 'PROFILE', fields: [] });

    expect(result).to.deep.equal({
      id: 'dmo-1',
      apiName: 'Account_DMO__dlm',
      properties: { name: 'Account_DMO__dlm', category: 'PROFILE', fields: [] },
    });
    expect(adapter.fieldClassification).to.not.have.property('fieldMappings');
  });

  it('lookup() by name GETs the single-object endpoint directly, not the paginated list (the real list defaults to limit=50 and can omit DMOs that still resolve by name)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectAdapter();
    client.on('GET', '/ssot/data-model-objects/Account_DMO__dlm', () => ({
      id: 'dmo-1',
      name: 'Account_DMO__dlm',
    }));

    const result = await adapter.lookup({ client }, { name: 'Account_DMO__dlm' });

    expect(result).to.deep.equal({
      id: 'dmo-1',
      apiName: 'Account_DMO__dlm',
      properties: { name: 'Account_DMO__dlm' },
    });
  });

  it('lookup() with no name falls back to the generic list-and-filter base behavior, using the singular `dataModelObject` list key despite it being an array', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectAdapter();
    client.on('GET', '/ssot/data-model-objects', () => ({
      dataModelObject: [{ id: 'dmo-1', apiName: 'Account_DMO__dlm' }],
    }));

    const result = await adapter.lookup({ client }, { apiName: 'Account_DMO__dlm' });

    expect(result?.id).to.equal('dmo-1');
  });
});
