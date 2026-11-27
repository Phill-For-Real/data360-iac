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
import { DataTransformAdapter } from '../../src/adapters/data-transform.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('DataTransformAdapter', () => {
  it('update() uses PUT, not PATCH', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataTransformAdapter();
    client.on('PUT', '/ssot/data-transforms/transform-1', () => ({ id: 'transform-1', name: 'transform-1' }));

    await adapter.update({ client }, 'transform-1', { label: 'Updated' });

    expect(client.calls[0].method).to.equal('PUT');
  });

  it('passes an STL node-graph definition through untouched', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataTransformAdapter();
    // type: "BATCH" requires definition.type: "STL" (a node-graph) -- confirmed live,
    // "SQL" is rejected for BATCH with "Expect either STL or DCSQL definition type with Batch type".
    const definition = {
      type: 'STL',
      version: '63.0',
      nodes: {
        LOAD_DATASET0: {
          action: 'load',
          parameters: { dataset: { name: 'account_dlo__dll', type: 'dataLakeObject' }, fields: ['Id__c'] },
          sources: [],
        },
      },
    };
    client.on('POST', '/ssot/data-transforms', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'transform-1',
    }));

    const result = await adapter.create({ client }, { name: 'AssetTransform', type: 'BATCH', definition });

    expect(result?.properties.definition).to.deep.equal(definition);
  });
});
