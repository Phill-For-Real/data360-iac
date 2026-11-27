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
import { ClassificationAssignmentAdapter } from '../../src/adapters/classification-assignment.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('ClassificationAssignmentAdapter', () => {
  it('creates a classification assignment via a plain POST', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ClassificationAssignmentAdapter();
    client.on('POST', '/ssot/data-governance/classification-assignments', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'class-assign-1',
      classificationName: 'PII',
    }));

    const result = await adapter.create(
      { client },
      {
        classificationFullyQualifiedName: 'Compliance_Classifications.PII',
        tagFullyQualifiedName: 'Compliance_Tags.PII.Email',
      }
    );

    expect(result?.id).to.equal('class-assign-1');
  });

  it('lookup() filters by classificationFullyQualifiedName/tagFullyQualifiedName query params', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ClassificationAssignmentAdapter();
    client.on(
      'GET',
      '/ssot/data-governance/classification-assignments?classificationFullyQualifiedName=Compliance_Classifications.PII&tagFullyQualifiedName=Compliance_Tags.PII.Email',
      () => ({
        classificationAssignments: [
          {
            id: 'class-assign-1',
            classificationFullyQualifiedName: 'Compliance_Classifications.PII',
            tagFullyQualifiedName: 'Compliance_Tags.PII.Email',
          },
        ],
      })
    );

    const result = await adapter.lookup(
      { client },
      {
        classificationFullyQualifiedName: 'Compliance_Classifications.PII',
        tagFullyQualifiedName: 'Compliance_Tags.PII.Email',
      }
    );

    expect(result?.id).to.equal('class-assign-1');
  });

  it('classifies both fields as replace -- no PATCH endpoint exists', () => {
    const adapter = new ClassificationAssignmentAdapter();
    expect(adapter.fieldClassification.classificationFullyQualifiedName).to.equal('replace');
    expect(adapter.fieldClassification.tagFullyQualifiedName).to.equal('replace');
  });
});
