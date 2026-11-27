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
import { Connection } from '@salesforce/core';
import { DataStreamAdapter } from '../../src/adapters/data-stream.js';
import { FakeConnectRestClient, RealConnectRestClient } from '../../src/connect-rest/client.js';

describe('DataStreamAdapter', () => {
  const properties = {
    name: 'vehicle_stream',
    label: 'Vehicle Stream',
    connectorInfo: { connectorType: 'AwsS3', connectorDetails: { name: 'Vehicle_abc' } },
  };
  const liveStream = {
    ...properties,
    name: 'Vehicle_Stream_generated',
    id: 'source-1',
    recordId: 'record-1',
    dataLakeObjectInfo: { name: 'Vehicle_DLO_generated__dll' },
  };

  it('recovers a stream created before its response timed out without issuing a second POST', async () => {
    const calls: string[] = [];
    let created: typeof liveStream | undefined;
    const connection = {
      request: async (req: { method: string; url: string }) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.method === 'POST') {
          created = liveStream;
          return new Promise(() => {});
        }
        return { dataStreams: [created] };
      },
    } as unknown as Connection;
    const client = new RealConnectRestClient(connection, 10);
    const result = await new DataStreamAdapter().create({ client }, properties);
    expect(result?.id).to.equal('record-1');
    expect(result?.properties.dlApiName).to.equal('Vehicle_DLO_generated__dll');
    expect(calls).to.deep.equal(['POST /ssot/data-streams', 'GET /ssot/data-streams?connectionName=Vehicle_abc']);
  });

  it('recovers from the duplicate EDTO error on a resumed apply, following pagination', async () => {
    const client = new FakeConnectRestClient();
    client.on('POST', '/ssot/data-streams', () => {
      throw new Error("Unable to create a data-stream. EDTO 'vehicle_dlo' already in use. Connector name: Vehicle");
    });
    client.on('GET', '/ssot/data-streams?connectionName=Vehicle_abc', () => ({
      dataStreams: [
        { ...liveStream, connectorInfo: { ...liveStream.connectorInfo, connectorDetails: { name: 'Other' } } },
      ],
      nextPageUrl: '/ssot/data-streams?offset=1',
    }));
    client.on('GET', '/ssot/data-streams?offset=1', () => ({ dataStreams: [liveStream] }));
    const result = await new DataStreamAdapter().create({ client }, properties);
    expect(result?.id).to.equal('record-1');
    expect(result?.apiName).to.equal('Vehicle_Stream_generated');
    expect(client.calls.filter((call) => call.method === 'POST')).to.have.length(1);
  });

  for (const scenario of ['missing', 'ambiguous', 'wrong-connection', 'lookup-error', 'validation']) {
    it(`preserves the create error when reconciliation is ${scenario}`, async () => {
      const client = new FakeConnectRestClient();
      const error = new Error(scenario === 'validation' ? 'INVALID_FIELD' : "EDTO 'vehicle_dlo' already in use");
      client.on('POST', '/ssot/data-streams', () => {
        throw error;
      });
      const live = liveStream;
      client.on('GET', '/ssot/data-streams?connectionName=Vehicle_abc', () => {
        if (scenario === 'lookup-error') throw new Error('lookup failed');
        return {
          dataStreams:
            scenario === 'missing'
              ? []
              : scenario === 'ambiguous'
              ? [live, { ...live, recordId: 'record-2' }]
              : [{ ...live, connectorInfo: { ...live.connectorInfo, connectorDetails: { name: 'Other' } } }],
        };
      });
      try {
        await new DataStreamAdapter().create({ client }, properties);
        expect.fail('expected create to throw');
      } catch (caught) {
        expect(caught).to.equal(error);
      }
      expect(client.calls.filter((call) => call.method === 'POST')).to.have.length(1);
      if (scenario === 'validation') expect(client.calls).to.have.length(1);
    });
  }

  for (const scenario of ['matching', 'wrong-field', 'wrong-primary-key', 'wrong-space', 'ambiguous', 'incomplete']) {
    it(`reconciles the verified IngestApi GET shape with a generated label: ${scenario}`, async () => {
      const client = new FakeConnectRestClient();
      const desired = {
        name: 'account_stream',
        label: 'Account Stream',
        connectionId: 'connection-1',
        datastreamType: 'INGEST_API',
        connectorInfo: {
          connectorType: 'IngestApi',
          connectorDetails: { name: 'Account_generated', events: ['account_dlo'] },
        },
        dataLakeObjectInfo: {
          name: 'account_dlo',
          label: 'Account DLO',
          category: 'Profile',
          dataspaceInfo: [{ name: 'default' }],
          dataLakeFieldInputRepresentations: [
            { name: 'accountId', dataType: 'Text', isPrimaryKey: true },
            { name: 'accountName', dataType: 'Text' },
          ],
        },
      };
      const stream = {
        name: 'Account_account_dlo_generated',
        label: 'Account-account_dlo',
        recordId: 'record-account',
        connectorInfo: { connectorType: 'IngestApi' },
        dataStreamType: 'INGESTAPI',
        status: 'ACTIVE',
        sourceFields: [
          { name: 'accountName', datatype: scenario === 'wrong-field' ? 'Number' : 'Text' },
          { name: 'accountId', datatype: 'Text' },
        ],
        dataLakeObjectInfo: {
          name: 'Account_account_dlo_generated__dll',
          label: 'Account DLO',
          category: 'Profile',
          dataSpaceInfo: [{ name: scenario === 'wrong-space' ? 'other' : 'default' }],
          dataLakeFieldInfoRepresentation: [
            { name: 'accountId', dataType: 'Text', isPrimaryKey: scenario !== 'wrong-primary-key' },
            { name: 'accountName', dataType: 'Text', isPrimaryKey: false },
          ],
        },
      };
      const timeout = new Error('Request timed out after 15000ms');
      client.on('PUT', '/ssot/connections/connection-1/schema', () => ({}));
      client.on('POST', '/ssot/data-streams', () => {
        throw timeout;
      });
      client.on('GET', '/ssot/data-streams?connectionName=Account_generated', () => ({
        dataStreams: scenario === 'ambiguous' ? [stream, { ...stream, recordId: 'another-record' }] : [stream],
        totalSize: scenario === 'incomplete' ? 2 : scenario === 'ambiguous' ? 2 : 1,
      }));
      if (scenario === 'matching') {
        const result = await new DataStreamAdapter().create({ client }, desired);
        expect(result?.id).to.equal('record-account');
        expect(result?.properties.dlApiName).to.equal('Account_account_dlo_generated__dll');
      } else {
        try {
          await new DataStreamAdapter().create({ client }, desired);
          expect.fail('expected failure');
        } catch (error) {
          expect(error).to.equal(timeout);
        }
      }
      expect(client.calls.filter((c) => c.method === 'POST')).to.have.length(1);
    });
  }

  it('create embeds and returns the materialized DLO synchronously, no separate wait step', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataStreamAdapter();
    client.on('POST', '/ssot/data-streams', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'stream-1',
      // The real API's create response carries a second, distinct identifier -- `recordId` --
      // which is the only one GET/PATCH/DELETE actually accept (confirmed live). `toReadResult`
      // must track `recordId`, not `id`.
      recordId: 'record-1',
      status: 'PROCESSING',
      dataLakeObjectInfo: { id: 'dlo-1', name: 'account_dlo__dll', status: 'PROCESSING' },
    }));

    const result = await adapter.create({ client }, { name: 'account_stream' });

    expect(result?.id).to.equal('record-1');
    expect(result?.properties.dataLakeObjectInfo).to.deep.equal({
      id: 'dlo-1',
      name: 'account_dlo__dll',
      status: 'PROCESSING',
    });
    expect(result?.properties.dlApiName).to.equal('account_dlo__dll');
    expect('waitForCompletion' in adapter).to.equal(false);
  });

  it('delete defaults shouldDeleteDataLakeObject to true', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataStreamAdapter();
    client.on('DELETE', '/ssot/data-streams/stream-1?shouldDeleteDataLakeObject=true', () => ({}));

    await adapter.delete({ client }, 'stream-1');

    expect(client.calls).to.deep.equal([
      { method: 'DELETE', path: '/ssot/data-streams/stream-1?shouldDeleteDataLakeObject=true' },
    ]);
  });

  it('create() for connectorType IngestApi upserts a schema on the connection first, then trims the stream body to the primary key field only', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataStreamAdapter();

    client.on('PUT', '/ssot/connections/conn-1/schema', (req) => ({
      schemas: (req.body as { schemas: unknown[] }).schemas,
    }));
    client.on('POST', '/ssot/data-streams', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'stream-1',
      recordId: 'record-1',
      dataLakeObjectInfo: { ...((req.body as Record<string, unknown>).dataLakeObjectInfo as object), id: 'dlo-1' },
    }));

    const result = await adapter.create(
      { client },
      {
        name: 'account_stream',
        connectionId: 'conn-1',
        datastreamType: 'INGEST_API',
        connectorInfo: {
          connectorType: 'IngestApi',
          connectorDetails: { name: 'Core_CRM_abc123', events: ['account_dlo'] },
        },
        dataLakeObjectInfo: {
          name: 'account_dlo',
          label: 'Account DLO',
          category: 'Profile',
          dataspaceInfo: [{ name: 'default' }],
          dataLakeFieldInputRepresentations: [
            { name: 'Id', label: 'Id', dataType: 'Text', isPrimaryKey: true },
            { name: 'Name', label: 'Name', dataType: 'Text', isPrimaryKey: false },
          ],
        },
        mappings: [],
        refreshConfig: { refreshMode: 'UPSERT' },
      }
    );

    const schemaCall = client.calls.find((c) => c.method === 'PUT' && c.path === '/ssot/connections/conn-1/schema');
    expect(schemaCall?.body).to.deep.equal({
      schemas: [
        {
          name: 'account_dlo',
          // Confirmed live: the real endpoint rejects a label with spaces (e.g. the DLO's free-text
          // "Account DLO" label) with InvalidCharacterObjectName -- the DLO's real `name` is sent for
          // both fields instead.
          label: 'account_dlo',
          schemaType: 'IngestApi',
          fields: [
            { name: 'Id', label: 'Id', dataType: 'Text' },
            { name: 'Name', label: 'Name', dataType: 'Text' },
          ],
        },
      ],
    });

    const streamCall = client.calls.find((c) => c.method === 'POST' && c.path === '/ssot/data-streams');
    expect(streamCall?.body).to.not.have.property('connectionId');
    const dlo = (streamCall?.body as Record<string, unknown>).dataLakeObjectInfo as Record<string, unknown>;
    expect(dlo.dataLakeFieldInputRepresentations).to.deep.equal([
      { name: 'Id', label: 'Id', dataType: 'Text', isPrimaryKey: true },
    ]);
    // Without this, the real API materializes every field (including the primary key) with
    // isPrimaryKey: false -- confirmed live.
    expect((streamCall?.body as Record<string, unknown>).sourceFields).to.deep.equal([
      { name: 'Id', dataType: 'Text' },
      { name: 'Name', dataType: 'Text' },
    ]);

    expect(result?.id).to.equal('record-1');
  });
});
