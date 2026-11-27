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
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { runDiscovery, DiscoverEndpointResult } from '../../src/discover/run-discovery.js';
import { DISCOVER_ENDPOINTS } from '../../src/discover/endpoints.js';

describe('runDiscovery', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-discover-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Wires every non-skipped, non-Connections endpoint to a minimal default response so a full
   * run completes without "no handler registered" errors; individual tests override specific
   * endpoints to exercise interesting shapes/failures.
   */
  function buildClient(overrides: Record<string, () => unknown> = {}): FakeConnectRestClient {
    const client = new FakeConnectRestClient();
    for (const endpoint of DISCOVER_ENDPOINTS) {
      if (endpoint.skipReason || endpoint.path === '/ssot/connections') continue;
      client.on('GET', endpoint.path, () => ({ items: [] }));
    }
    client.on('GET', '/ssot/connectors', () => ({ connectorInfoList: [] }));
    for (const [path, handler] of Object.entries(overrides)) {
      const [method, ...rest] = path.split(' ');
      client.on(method as 'GET', rest.join(' '), handler);
    }
    return client;
  }

  it('writes a plain-array response to its own file under the endpoint folder', async () => {
    const client = buildClient({
      'GET /ssot/data-lake-objects': () => ({ dataLakeObjects: [{ id: 'dlo-1' }, { id: 'dlo-2' }] }),
    });

    const results = await runDiscovery({ client }, dir);

    const dlo = results.find((r) => r.path === '/ssot/data-lake-objects')!;
    expect(dlo.status).to.equal('fetched');
    expect(dlo.itemCount).to.equal(2);

    const written = JSON.parse(await readFile(join(dir, 'Data Lake Objects', 'data-lake-objects.json'), 'utf8'));
    expect(written).to.deep.equal({ dataLakeObjects: [{ id: 'dlo-1' }, { id: 'dlo-2' }] });
  });

  it('writes a nested-envelope response (collection.items) as-is without reshaping', async () => {
    const client = buildClient({
      'GET /ssot/calculated-insights': () => ({ collection: { items: [{ apiName: 'CI1' }] } }),
    });

    const results = await runDiscovery({ client }, dir);

    const ci = results.find((r) => r.path === '/ssot/calculated-insights')!;
    expect(ci.status).to.equal('fetched');
    expect(ci.itemCount).to.equal(1);

    const written = JSON.parse(await readFile(join(dir, 'Calculated Insights', 'calculated-insights.json'), 'utf8'));
    expect(written).to.deep.equal({ collection: { items: [{ apiName: 'CI1' }] } });
  });

  it('records a thrown request error as status "error" without aborting the rest', async () => {
    const client = buildClient({
      'GET /ssot/data-transforms': () => {
        throw new Error('boom');
      },
    });

    const results = await runDiscovery({ client }, dir);

    const transforms = results.find((r) => r.path === '/ssot/data-transforms')!;
    expect(transforms.status).to.equal('error');
    expect(transforms.error).to.include('boom');

    const dlo = results.find((r) => r.path === '/ssot/data-lake-objects')!;
    expect(dlo.status).to.equal('fetched');
  });

  it('records endpoints with a skipReason as "skipped" without ever requesting them', async () => {
    const client = buildClient();

    const results = await runDiscovery({ client }, dir);

    const skipped = results.filter((r) => r.status === 'skipped');
    expect(skipped.length).to.be.greaterThan(0);
    for (const s of skipped) {
      expect(s.skipReason).to.be.a('string').with.length.greaterThan(0);
    }
    const requestedPaths = client.calls.map((c) => c.path.split('?')[0]);
    for (const s of skipped) {
      expect(requestedPaths).to.not.include(s.path);
    }
  });

  it('merges connections across every real connector type found via GET /ssot/connectors', async () => {
    const client = buildClient({
      'GET /ssot/connectors': () => ({
        connectorInfoList: [{ name: 'SalesforceDotCom' }, { name: 'AwsS3' }],
      }),
      'GET /ssot/connections?connectorType=SalesforceDotCom': () => ({
        connections: [{ id: 'conn-1', connectorType: 'SalesforceDotCom' }],
      }),
      'GET /ssot/connections?connectorType=AwsS3': () => ({
        connections: [{ id: 'conn-2', connectorType: 'AwsS3' }],
      }),
    });

    const results = await runDiscovery({ client }, dir);

    const connectors = results.find((r) => r.path === '/ssot/connectors')!;
    expect(connectors.status).to.equal('fetched');

    const connections = results.find((r) => r.path === '/ssot/connections')!;
    expect(connections.status).to.equal('fetched');
    expect(connections.itemCount).to.equal(2);

    const written = JSON.parse(await readFile(join(dir, 'Connections', 'connections.json'), 'utf8')) as {
      connections: Array<{ id: string }>;
    };
    expect(written.connections).to.have.lengthOf(2);
    expect(written.connections.map((c) => c.id)).to.deep.equal(['conn-1', 'conn-2']);
  });

  it('includes a connector type seen only in Data Streams, not just the connectors catalog', async () => {
    // Regression test: a real org had connections of type IngestApi/MarketingDataConnector that
    // never appeared in GET /ssot/connectors at all, but did surface in a Data Stream's
    // connectorInfo.connectorType.
    const client = buildClient({
      'GET /ssot/connectors': () => ({ connectorInfoList: [{ name: 'SalesforceDotCom' }] }),
      'GET /ssot/data-streams': () => ({
        dataStreams: [{ name: 'stream1', connectorInfo: { connectorType: 'IngestApi' } }],
      }),
      'GET /ssot/connections?connectorType=SalesforceDotCom': () => ({
        connections: [{ id: 'conn-1', connectorType: 'SalesforceDotCom' }],
      }),
      'GET /ssot/connections?connectorType=IngestApi': () => ({
        connections: [{ id: 'conn-2', connectorType: 'IngestApi' }],
      }),
    });

    await runDiscovery({ client }, dir);

    const written = JSON.parse(await readFile(join(dir, 'Connections', 'connections.json'), 'utf8')) as {
      connections: Array<{ id: string; connectorType: string }>;
    };
    expect(written.connections.map((c) => c.connectorType)).to.include('IngestApi');
  });

  it('fully paginates a flat nextPageUrl response before writing the merged array', async () => {
    const client = buildClient({
      'GET /ssot/data-lake-objects': () => ({
        dataLakeObjects: [{ id: 'dlo-1' }],
        totalSize: 2,
        nextPageUrl: '/services/data/v68.0/ssot/data-lake-objects?limit=1&offset=1',
      }),
      'GET /services/data/v68.0/ssot/data-lake-objects?limit=1&offset=1': () => ({
        dataLakeObjects: [{ id: 'dlo-2' }],
        totalSize: 2,
      }),
    });

    const results = await runDiscovery({ client }, dir);

    const dlo = results.find((r) => r.path === '/ssot/data-lake-objects')!;
    expect(dlo.status).to.equal('fetched');
    expect(dlo.itemCount).to.equal(2);

    const written = JSON.parse(await readFile(join(dir, 'Data Lake Objects', 'data-lake-objects.json'), 'utf8')) as {
      dataLakeObjects: Array<{ id: string }>;
    };
    expect(written.dataLakeObjects.map((d) => d.id)).to.deep.equal(['dlo-1', 'dlo-2']);

    const secondPageCall = client.calls.find(
      (c) => c.path === '/services/data/v68.0/ssot/data-lake-objects?limit=1&offset=1'
    );
    expect(secondPageCall).to.exist;
  });

  it('fully paginates a collection-nested nextPageUrl response, merging into collection.items', async () => {
    const client = buildClient({
      'GET /ssot/calculated-insights': () => ({
        collection: {
          items: [{ apiName: 'CI1' }],
          total: 2,
          nextPageUrl: '/services/data/v68.0/ssot/calculated-insights?pageToken=abc',
        },
      }),
      'GET /services/data/v68.0/ssot/calculated-insights?pageToken=abc': () => ({
        collection: { items: [{ apiName: 'CI2' }], total: 2 },
      }),
    });

    const results = await runDiscovery({ client }, dir);

    const ci = results.find((r) => r.path === '/ssot/calculated-insights')!;
    expect(ci.status).to.equal('fetched');
    expect(ci.itemCount).to.equal(2);

    const written = JSON.parse(
      await readFile(join(dir, 'Calculated Insights', 'calculated-insights.json'), 'utf8')
    ) as { collection: { items: Array<{ apiName: string }> } };
    expect(written.collection.items.map((i) => i.apiName)).to.deep.equal(['CI1', 'CI2']);
  });

  it('records connections as errored if the connectors enumeration call itself fails', async () => {
    const client = buildClient({
      'GET /ssot/connectors': () => {
        throw new Error('connectors unavailable');
      },
    });

    const results = await runDiscovery({ client }, dir);

    const connectors = results.find((r) => r.path === '/ssot/connectors')!;
    expect(connectors.status).to.equal('error');

    const connections = results.find((r) => r.path === '/ssot/connections')!;
    expect(connections.status).to.equal('error');
    expect(connections.error).to.include('connectors');
  });

  it('writes a summary.json listing every endpoint outcome', async () => {
    const client = buildClient();

    const results = await runDiscovery({ client }, dir);

    const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as unknown[];
    expect(summary).to.have.lengthOf(results.length);
    expect(summary.length).to.equal(DISCOVER_ENDPOINTS.length);
  });

  it('calls onProgress once per endpoint, live, as each outcome becomes known', async () => {
    const client = buildClient();
    const progressed: DiscoverEndpointResult[] = [];

    const results = await runDiscovery({ client }, dir, (result) => progressed.push(result));

    expect(progressed).to.have.lengthOf(DISCOVER_ENDPOINTS.length);
    expect(progressed.length).to.equal(results.length);
    // Every result the final array reports was also seen by the progress callback.
    const progressedKeys = new Set(progressed.map((r) => `${r.folder}/${r.fileName}`));
    for (const result of results) {
      expect(progressedKeys.has(`${result.folder}/${result.fileName}`)).to.equal(true);
    }
  });

  it('fans a dmoNames-dependent endpoint out over every DMO discovered from Metadata and Data Model Objects', async () => {
    const client = buildClient({
      'GET /ssot/metadata-entities': () => ({
        metadata: [
          { type: 'DataModelObject', name: 'Account_DMO' },
          { type: 'DataLakeObject', name: 'not_a_dmo' },
        ],
      }),
      'GET /ssot/data-model-objects': () => ({ dataModelObject: [{ name: 'Asset_DMO' }] }),
      'GET /ssot/activations/metadata/data-sources?dataModelObjectApiName=Account_DMO': () => ({
        dataSources: ['crm'],
      }),
      'GET /ssot/activations/metadata/data-sources?dataModelObjectApiName=Asset_DMO': () => ({
        dataSources: ['iot'],
      }),
    });

    const results = await runDiscovery({ client }, dir);

    const dataSources = results.find((r) => r.path === '/ssot/activations/metadata/data-sources')!;
    expect(dataSources.status).to.equal('fetched');
    expect(dataSources.itemCount).to.equal(2);

    const written = JSON.parse(await readFile(join(dir, 'Activations', 'data-sources.json'), 'utf8')) as Record<
      string,
      { dataSources: string[] }
    >;
    expect(Object.keys(written).sort()).to.deep.equal(['Account_DMO', 'Asset_DMO']);
    expect(written.Account_DMO.dataSources).to.deep.equal(['crm']);
    expect(written.Asset_DMO.dataSources).to.deep.equal(['iot']);
  });

  it('fans a dataSpaceNames-dependent endpoint out over every data space discovered from Data Spaces', async () => {
    const client = buildClient({
      'GET /ssot/data-spaces': () => ({ dataSpaces: [{ name: 'default' }, { name: 'B2B' }] }),
      'GET /ssot/activations/metadata/channels?dataSpace=default': () => ({ channels: ['Email'] }),
      'GET /ssot/activations/metadata/channels?dataSpace=B2B': () => ({ channels: ['Push'] }),
    });

    const results = await runDiscovery({ client }, dir);

    const channels = results.find((r) => r.path === '/ssot/activations/metadata/channels')!;
    expect(channels.status).to.equal('fetched');
    expect(channels.itemCount).to.equal(2);

    const written = JSON.parse(await readFile(join(dir, 'Activations', 'channels.json'), 'utf8')) as Record<
      string,
      { channels: string[] }
    >;
    expect(Object.keys(written).sort()).to.deep.equal(['B2B', 'default']);
  });

  it('records a per-entity fan-out failure under its own key without dropping the others', async () => {
    const client = buildClient({
      'GET /ssot/data-spaces': () => ({ dataSpaces: [{ name: 'default' }, { name: 'B2B' }] }),
      'GET /ssot/activations/metadata/channels?dataSpace=default': () => ({ channels: ['Email'] }),
      'GET /ssot/activations/metadata/channels?dataSpace=B2B': () => {
        throw new Error('B2B unavailable');
      },
    });

    await runDiscovery({ client }, dir);

    const written = JSON.parse(await readFile(join(dir, 'Activations', 'channels.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written.default).to.deep.equal({ channels: ['Email'] });
    const b2bError = written.B2B as Record<string, string>;
    expect(b2bError['__error']).to.include('B2B unavailable');
  });
});
