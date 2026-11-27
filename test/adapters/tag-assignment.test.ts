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
import { TagAssignmentAdapter } from '../../src/adapters/tag-assignment.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('TagAssignmentAdapter', () => {
  it('creates a tag assignment via a plain POST', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new TagAssignmentAdapter();
    client.on('POST', '/ssot/data-governance/tag-assignments', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'tag-assign-1',
      tagName: 'Email',
      tagLabel: 'Email Address',
    }));

    const result = await adapter.create(
      { client },
      { tagFullyQualifiedName: 'Compliance_Tags.PII.Email', objectName: 'account_dlo__dll', fieldName: 'Email' }
    );

    expect(result).to.deep.equal({
      id: 'tag-assign-1',
      apiName: undefined,
      properties: {
        tagFullyQualifiedName: 'Compliance_Tags.PII.Email',
        objectName: 'account_dlo__dll',
        fieldName: 'Email',
        tagName: 'Email',
        tagLabel: 'Email Address',
      },
    });
  });

  it('lookup() filters by objectName/fieldName/tagFullyQualifiedName query params', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new TagAssignmentAdapter();
    client.on(
      'GET',
      '/ssot/data-governance/tag-assignments?objectName=account_dlo__dll&fieldName=Email&tagFullyQualifiedName=Compliance_Tags.PII.Email',
      () => ({
        tagAssignments: [
          {
            id: 'tag-assign-1',
            objectName: 'account_dlo__dll',
            fieldName: 'Email',
            tagFullyQualifiedName: 'Compliance_Tags.PII.Email',
          },
        ],
      })
    );

    const result = await adapter.lookup(
      { client },
      { objectName: 'account_dlo__dll', fieldName: 'Email', tagFullyQualifiedName: 'Compliance_Tags.PII.Email' }
    );

    expect(result?.id).to.equal('tag-assign-1');
  });

  it('read() and delete() use the real member path, no PATCH exists', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new TagAssignmentAdapter();
    client.on('GET', '/ssot/data-governance/tag-assignments/tag-assign-1', () => ({ id: 'tag-assign-1' }));
    client.on('DELETE', '/ssot/data-governance/tag-assignments/tag-assign-1', () => ({}));

    const result = await adapter.read({ client }, 'tag-assign-1');
    await adapter.delete({ client }, 'tag-assign-1');

    expect(result?.id).to.equal('tag-assign-1');
  });

  it('classifies tagFullyQualifiedName/objectName/fieldName as replace -- no PATCH endpoint exists', () => {
    const adapter = new TagAssignmentAdapter();
    expect(adapter.fieldClassification.tagFullyQualifiedName).to.equal('replace');
    expect(adapter.fieldClassification.objectName).to.equal('replace');
    expect(adapter.fieldClassification.fieldName).to.equal('replace');
  });
});
