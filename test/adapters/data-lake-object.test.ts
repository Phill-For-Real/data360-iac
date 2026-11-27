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
import { DataLakeObjectAdapter } from '../../src/adapters/data-lake-object.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('DataLakeObjectAdapter', () => {
  it('creates a DLO via a plain POST -- independently of any DataStream', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataLakeObjectAdapter();
    client.on('POST', '/ssot/data-lake-objects', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'dlo-1',
      name: 'standalone_audit_dlo__dll',
      status: 'PROCESSING',
    }));

    const result = await adapter.create({ client }, { name: 'standalone_audit_dlo', category: 'Other' });

    expect(result).to.deep.equal({
      id: 'dlo-1',
      apiName: 'standalone_audit_dlo__dll',
      properties: {
        name: 'standalone_audit_dlo__dll',
        status: 'PROCESSING',
        category: 'Other',
      },
    });
    expect(client.calls).to.have.lengthOf(1);
  });

  it('lookup() lists and filters client-side since no name/label filter query param exists', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataLakeObjectAdapter();
    client.on('GET', '/ssot/data-lake-objects', () => ({
      dataLakeObjects: [
        { id: 'dlo-1', name: 'account_dlo__dll' },
        { id: 'dlo-2', name: 'asset_dlo__dll' },
      ],
    }));

    const result = await adapter.lookup({ client }, { name: 'asset_dlo__dll' });

    expect(result).to.deep.equal({
      id: 'dlo-2',
      apiName: 'asset_dlo__dll',
      properties: { name: 'asset_dlo__dll' },
    });
  });

  it('read() and delete() use the real member path, no job polling', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataLakeObjectAdapter();
    client.on('GET', '/ssot/data-lake-objects/dlo-1', () => ({ id: 'dlo-1', name: 'account_dlo__dll' }));
    client.on('DELETE', '/ssot/data-lake-objects/dlo-1', () => ({}));

    const result = await adapter.read({ client }, 'dlo-1');
    await adapter.delete({ client }, 'dlo-1');

    expect(result).to.deep.equal({
      id: 'dlo-1',
      apiName: 'account_dlo__dll',
      properties: { name: 'account_dlo__dll' },
    });
    expect('waitForCompletion' in adapter).to.equal(false);
  });

  it('delete() retries on the DataTransform-teardown race ("referenced elsewhere in Salesforce") and succeeds once it clears', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataLakeObjectAdapter();
    let callCount = 0;
    client.on('DELETE', '/ssot/data-lake-objects/dlo-1', () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error(
          'DEPENDENCY_EXISTS: Data Lake Object dlo-1 is referenced elsewhere in Salesforce. Remove the usage and try again.'
        );
      }
      return {};
    });

    await adapter.delete({ client }, 'dlo-1');

    expect(callCount).to.equal(2);
  });

  it('delete() does not retry an unrelated error', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new DataLakeObjectAdapter();
    let callCount = 0;
    client.on('DELETE', '/ssot/data-lake-objects/dlo-1', () => {
      callCount += 1;
      throw new Error('SOME_OTHER_ERROR: not found');
    });

    try {
      await adapter.delete({ client }, 'dlo-1');
      expect.fail('expected delete to throw');
    } catch (e) {
      expect((e as Error).message).to.include('SOME_OTHER_ERROR');
    }
    expect(callCount).to.equal(1);
  });

  it('classifies name/category/dataspaceInfo as replace (name is required on create)', () => {
    const adapter = new DataLakeObjectAdapter();
    expect(adapter.fieldClassification.name).to.equal('replace');
    expect(adapter.fieldClassification.category).to.equal('replace');
    expect(adapter.fieldClassification.dataspaceInfo).to.equal('replace');
  });
});
