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
import { DataModelObjectMappingAdapter } from '../../src/adapters/data-model-object-mapping.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('DataModelObjectMappingAdapter', () => {
  it('create() sends the required dataspace query param and uses the server-generated developerName as both id and apiName', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectMappingAdapter();
    client.on('POST', '/ssot/data-model-object-mappings?dataspace=default', (req) => ({
      ...(req.body as Record<string, unknown>),
      developerName: 'account_dlo_map_Account_DMO_12345',
      status: 'CREATING',
    }));

    const result = await adapter.create(
      { client },
      {
        sourceEntityDeveloperName: 'account_dlo__dll',
        targetEntityDeveloperName: 'Account_DMO__dlm',
        fieldMapping: [{ sourceFieldDeveloperName: 'Name', targetFieldDeveloperName: 'CompanyName' }],
      }
    );

    expect(result?.id).to.equal('account_dlo_map_Account_DMO_12345');
    expect(result?.apiName).to.equal('account_dlo_map_Account_DMO_12345');
  });

  it('create() uses the manifest-declared dataSpaceName as the dataspace query param when present', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectMappingAdapter();
    client.on('POST', '/ssot/data-model-object-mappings?dataspace=custom_space', (req) => ({
      ...(req.body as Record<string, unknown>),
      developerName: 'mapping-1',
    }));

    await adapter.create(
      { client },
      {
        dataSpaceName: 'custom_space',
        sourceEntityDeveloperName: 'account_dlo__dll',
        targetEntityDeveloperName: 'Account_DMO__dlm',
      }
    );

    expect(client.calls.find((call) => call.method === 'POST')?.path).to.equal(
      '/ssot/data-model-object-mappings?dataspace=custom_space'
    );
  });

  it('lookup() filters by dloDeveloperName/dmoDeveloperName query params', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataModelObjectMappingAdapter();
    client.on(
      'GET',
      '/ssot/data-model-object-mappings?dloDeveloperName=account_dlo__dll&dmoDeveloperName=Account_DMO__dlm',
      () => ({
        objectSourceTargetMaps: [
          {
            developerName: 'account_dlo_map_Account_DMO_12345',
            sourceEntityDeveloperName: 'account_dlo__dll',
            targetEntityDeveloperName: 'Account_DMO__dlm',
          },
        ],
      })
    );

    const result = await adapter.lookup(
      { client },
      { sourceEntityDeveloperName: 'account_dlo__dll', targetEntityDeveloperName: 'Account_DMO__dlm' }
    );

    expect(result?.id).to.equal('account_dlo_map_Account_DMO_12345');
  });

  for (const scenario of [
    'committed',
    'wrong-field',
    'ambiguous',
    'incomplete',
    'preexisting',
    'lookup-error',
    'unresolved',
  ]) {
    it(`reconciles a timed-out mapping create without replay: ${scenario}`, async () => {
      const client = new FakeConnectRestClient();
      const desired = {
        sourceEntityDeveloperName: 'account_dlo__dll',
        targetEntityDeveloperName: 'ssot__ContactPointAddress__dlm',
        fieldMapping: [
          { sourceFieldDeveloperName: 'billingCity__c', targetFieldDeveloperName: 'ssot__CityName__c' },
          { sourceFieldDeveloperName: 'accountId__c', targetFieldDeveloperName: 'ssot__Id__c' },
        ],
      };
      const candidate = {
        developerName: 'mapping-address',
        sourceEntityDeveloperName: desired.sourceEntityDeveloperName,
        targetEntityDeveloperName: desired.targetEntityDeveloperName,
        status: 'ACTIVE',
        fieldMappings: [
          {
            developerName: 'generated-field-1',
            sourceFieldDeveloperName: 'accountId__c',
            targetFieldDeveloperName: 'ssot__Id__c',
          },
          {
            developerName: 'generated-field-2',
            sourceFieldDeveloperName: 'billingCity__c',
            targetFieldDeveloperName: scenario === 'wrong-field' ? 'ssot__Other__c' : 'ssot__CityName__c',
          },
          { sourceFieldDeveloperName: 'DataSource__c', targetFieldDeveloperName: 'ssot__DataSourceId__c' },
          { sourceFieldDeveloperName: 'KQ_accountId__c', targetFieldDeveloperName: 'KQ_Id__c' },
        ],
      };
      let committed = false;
      const timeout = new Error('Request timed out after 15000ms');
      client.on(
        'GET',
        '/ssot/data-model-object-mappings?dataspace=default&dloDeveloperName=account_dlo__dll&dmoDeveloperName=ssot__ContactPointAddress__dlm',
        () => {
          if (scenario === 'lookup-error') throw new Error('Permission denied');
          if (!committed) return { objectSourceTargetMaps: scenario === 'preexisting' ? [candidate] : [] };
          return {
            objectSourceTargetMaps:
              scenario === 'unresolved'
                ? []
                : scenario === 'ambiguous'
                ? [candidate, { ...candidate, developerName: 'other' }]
                : [candidate],
            ...(scenario === 'incomplete' ? { nextPageUrl: '/ssot/data-model-object-mappings?offset=2' } : {}),
          };
        }
      );
      client.on('POST', '/ssot/data-model-object-mappings?dataspace=default', () => {
        committed = true;
        throw timeout;
      });
      if (scenario === 'committed') {
        const result = await new DataModelObjectMappingAdapter().create({ client }, desired);
        expect(result?.id).to.equal('mapping-address');
      } else {
        try {
          await new DataModelObjectMappingAdapter().create({ client }, desired);
          expect.fail('expected create to fail');
        } catch (error) {
          expect(error).to.equal(timeout);
        }
      }
      expect(client.calls.filter((c) => c.method === 'POST')).to.have.length(1);
    });
  }

  it('classifies every field as replace -- v1 only supports whole-mapping delete+recreate', () => {
    const adapter = new DataModelObjectMappingAdapter();
    expect(adapter.fieldClassification.sourceEntityDeveloperName).to.equal('replace');
    expect(adapter.fieldClassification.targetEntityDeveloperName).to.equal('replace');
    expect(adapter.fieldClassification.fieldMapping).to.equal('replace');
  });
  for (const mode of ['absent', 'wrong-name', 'wrong-code', 'permission', 'present']) {
    it(`confirms mapping deletion only with scoped provider evidence: ${mode}`, async () => {
      const client = new FakeConnectRestClient();
      client.on('GET', '/ssot/data-model-object-mappings/map-1', () => {
        if (mode === 'present') return { developerName: 'map-1', status: 'ACTIVE' };
        throw Object.assign(
          new Error(
            `Object Source Target Map not found for the given name : ${
              mode === 'wrong-name' ? 'another-map' : 'map-1'
            } `
          ),
          {
            name: mode === 'wrong-code' ? 'UNKNOWN_ERROR' : 'NOT_FOUND',
            errorCode: mode === 'wrong-code' ? 'UNKNOWN_ERROR' : 'NOT_FOUND',
            ...(mode === 'permission' ? { statusCode: 403 } : {}),
          }
        );
      });
      const result = await new DataModelObjectMappingAdapter().observeDeletion({ client }, 'map-1');
      expect(result.outcome).to.equal(mode === 'absent' ? 'absent' : mode === 'present' ? 'present' : 'unknown');
      expect(client.calls.every((request) => request.method === 'GET')).to.equal(true);
    });
  }
});
