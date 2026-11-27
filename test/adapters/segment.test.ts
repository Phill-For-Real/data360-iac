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
import { SegmentAdapter } from '../../src/adapters/segment.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('SegmentAdapter dual-id resolution', () => {
  it('create() returns the numeric marketSegmentId as id, and the real apiName', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    client.on('POST', '/ssot/segments', (req) => ({
      ...(req.body as Record<string, unknown>),
      apiName: 'high_risk_assets_segment',
      marketSegmentId: '1sg000001',
      segmentStatus: 'PROCESSING',
    }));

    const result = await adapter.create({ client }, { displayName: 'High Risk Assets' });

    expect(result).to.deep.include({ id: '1sg000001', apiName: 'high_risk_assets_segment' });
  });

  it('update() first re-GETs by id to resolve apiName, then PATCHes the apiName-keyed path', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    // GET /ssot/segments/{id} wraps its single result in { segments: [...] } -- confirmed live,
    // unlike the create/update responses (bare).
    client.on('GET', '/ssot/segments/1sg000001', () => ({
      segments: [{ marketSegmentId: '1sg000001', apiName: 'high_risk_assets_segment' }],
    }));
    client.on('PATCH', '/ssot/segments/high_risk_assets_segment', () => ({
      marketSegmentId: '1sg000001',
      apiName: 'high_risk_assets_segment',
      displayName: 'Updated',
    }));

    const result = await adapter.update({ client }, '1sg000001', { displayName: 'Updated' });

    expect(client.calls.map((c) => c.method)).to.deep.equal(['GET', 'PATCH']);
    expect(client.calls[1].path).to.equal('/ssot/segments/high_risk_assets_segment');
    expect(result).to.deep.include({ id: '1sg000001', apiName: 'high_risk_assets_segment' });
  });

  it('delete() first re-GETs by id to resolve apiName, then DELETEs the apiName-keyed path', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    client.on('GET', '/ssot/segments/1sg000001', () => ({
      segments: [{ marketSegmentId: '1sg000001', apiName: 'high_risk_assets_segment' }],
    }));
    client.on('DELETE', '/ssot/segments/high_risk_assets_segment', () => ({}));

    await adapter.delete({ client }, '1sg000001');

    expect(client.calls.map((c) => c.method)).to.deep.equal(['GET', 'DELETE']);
    expect(client.calls[1].path).to.equal('/ssot/segments/high_risk_assets_segment');
  });

  it('update() throws if the apiName cannot be resolved', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    client.on('GET', '/ssot/segments/1sg000001', () => undefined);

    try {
      await adapter.update({ client }, '1sg000001', {});
      expect.fail('expected update to throw');
    } catch (e) {
      expect((e as Error).message).to.include('apiName could not be resolved');
    }
  });

  it('read() unwraps the real { segments: [...] } response shape, pulling segmentStatus from the nested item (not the wrapper)', async () => {
    // Regression test: GET /ssot/segments/{id} wraps its single result in { segments: [...] },
    // unlike every other resource type's member-GET. Confirmed live: left unhandled, this made
    // `waitForCompletion`'s status poll always see segmentStatus: undefined and never reach a
    // terminal state, silently hanging until the full polling timeout.
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    client.on('GET', '/ssot/segments/1sg000001', () => ({
      segments: [{ marketSegmentId: '1sg000001', apiName: 'high_risk_assets_segment', segmentStatus: 'ACTIVE' }],
    }));

    const result = await adapter.read({ client }, '1sg000001');

    expect(result).to.deep.equal({
      id: '1sg000001',
      apiName: 'high_risk_assets_segment',
      properties: { marketSegmentId: '1sg000001', apiName: 'high_risk_assets_segment', segmentStatus: 'ACTIVE' },
    });
  });

  it('classifies segmentOnApiName/segmentType/developerName as replace (developerName is required on create, unsupported on update)', () => {
    const adapter = new SegmentAdapter();
    expect(adapter.fieldClassification.segmentOnApiName).to.equal('replace');
    expect(adapter.fieldClassification.segmentType).to.equal('replace');
    expect(adapter.fieldClassification.developerName).to.equal('replace');
    expect(adapter.fieldClassification.description).to.equal('update');
  });
});
