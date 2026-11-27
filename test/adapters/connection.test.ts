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
import { ConnectionAdapter } from '../../src/adapters/connection.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('ConnectionAdapter', () => {
  it('creates a connection, then looks it up by label since create returns an empty body and the real API rewrites name', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    client.on('POST', '/ssot/connections', () => ({}));
    client.on('GET', '/ssot/connections?connectorType=SalesforceDotCom&label=Core%20CRM', () => ({
      connections: [{ id: 'conn-1', name: 'Core_CRM_ff6ceb44', label: 'Core CRM', connectorType: 'SalesforceDotCom' }],
    }));

    const result = await adapter.create(
      { client },
      { connectorType: 'SalesforceDotCom', name: 'core_crm_connection', label: 'Core CRM' }
    );

    expect(result).to.deep.equal({
      id: 'conn-1',
      apiName: 'Core_CRM_ff6ceb44',
      properties: { name: 'Core_CRM_ff6ceb44', label: 'Core CRM', connectorType: 'SalesforceDotCom' },
    });
  });

  it('throws when the created connection cannot be found via label lookup', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    client.on('POST', '/ssot/connections', () => ({}));
    client.on('GET', '/ssot/connections?connectorType=SalesforceDotCom&label=Missing', () => ({ connections: [] }));

    try {
      await adapter.create({ client }, { connectorType: 'SalesforceDotCom', name: 'missing', label: 'Missing' });
      expect.fail('expected create to throw');
    } catch (e) {
      expect((e as Error).message).to.include('could not be found');
    }
  });

  it('updates a connection via a PATCH to its member path', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    client.on('PATCH', '/ssot/connections/conn-1', () => ({ id: 'conn-1', name: 'core_crm_connection' }));

    await adapter.update({ client }, 'conn-1', { connectorType: 'SalesforceDotCom' });

    expect(client.calls).to.have.lengthOf(1);
    expect(client.calls[0]).to.deep.equal({
      method: 'PATCH',
      path: '/ssot/connections/conn-1',
      body: { connectorType: 'SalesforceDotCom' },
    });
  });

  it('delete() retries on DEPENDENCY_EXISTS (a DataStream still tearing down) and succeeds once it clears', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    let callCount = 0;
    client.on('DELETE', '/ssot/connections/conn-1', () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error(
          'Message: DEPENDENCY_EXISTS\nHTTP response code: 400\nHTTP response body: null\nHTTP response headers: null'
        );
      }
      return {};
    });

    await adapter.delete({ client }, 'conn-1');

    expect(callCount).to.equal(2);
  });

  it('delete() does not retry an unrelated error', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    let callCount = 0;
    client.on('DELETE', '/ssot/connections/conn-1', () => {
      callCount += 1;
      throw new Error('NOT_FOUND');
    });

    try {
      await adapter.delete({ client }, 'conn-1');
      expect.fail('expected delete to throw');
    } catch (e) {
      expect((e as Error).message).to.equal('NOT_FOUND');
    }
    expect(callCount).to.equal(1);
  });

  it('classifies the full real discriminated-schema field set', () => {
    const adapter = new ConnectionAdapter();
    expect(adapter.fieldClassification.connectorType).to.equal('replace');
    expect(adapter.fieldClassification.name).to.equal('replace');
    expect(adapter.fieldClassification.organizationId).to.equal('replace');
    expect(adapter.fieldClassification.streamingAppType).to.equal('replace');
    expect(adapter.fieldClassification.method).to.equal('replace');
    expect(adapter.fieldClassification.label).to.equal('update');
    expect(adapter.fieldClassification.streamingAppSubType).to.equal('update');
    expect(adapter.fieldClassification.credentials).to.equal('update');
    expect(adapter.fieldClassification.parameters).to.equal('update');
  });

  it('passes organizationId through on create untouched (required live for SalesforceDotCom)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    client.on('POST', '/ssot/connections', () => ({}));
    client.on('GET', '/ssot/connections?connectorType=SalesforceDotCom&label=Core%20CRM', () => ({
      connections: [{ id: 'conn-1', name: 'Core_CRM_ff6ceb44', label: 'Core CRM', connectorType: 'SalesforceDotCom' }],
    }));

    await adapter.create(
      { client },
      {
        connectorType: 'SalesforceDotCom',
        name: 'core_crm_connection',
        label: 'Core CRM',
        organizationId: '00Dxx0000000001EAA',
      }
    );

    const createCall = client.calls.find((c) => c.method === 'POST' && c.path === '/ssot/connections');
    expect(createCall?.body).to.deep.equal({
      connectorType: 'SalesforceDotCom',
      name: 'core_crm_connection',
      label: 'Core CRM',
      organizationId: '00Dxx0000000001EAA',
    });
  });

  it('passes credentials/method/parameters through untouched on create (required live for non-discriminated connectorTypes like AwsS3)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ConnectionAdapter();
    client.on('POST', '/ssot/connections', () => ({}));
    client.on('GET', '/ssot/connections?connectorType=AwsS3&label=Fleet%20Telematics%20S3', () => ({
      connections: [
        { id: 'conn-2', name: 'Fleet_Telematics_S3_abc123', label: 'Fleet Telematics S3', connectorType: 'AwsS3' },
      ],
    }));

    const body = {
      connectorType: 'AwsS3',
      name: 'fleet_telematics_connection',
      label: 'Fleet Telematics S3',
      method: 'Ingress',
      credentials: { attributes: [{ name: 'accessKeyId', value: 'AKIA123' }] },
      parameters: { attributes: [{ name: 'bucketName', value: 'fleet-maintenance-bucket' }] },
    };

    await adapter.create({ client }, body);

    const createCall = client.calls.find((c) => c.method === 'POST' && c.path === '/ssot/connections');
    expect(createCall?.body).to.deep.equal(body);
  });
});
