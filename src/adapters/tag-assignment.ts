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
import { RestAdapterBase } from './rest-adapter-base.js';

/**
 * Tags a governance-taxonomy tag (e.g. `Compliance_Tags.PII.Email`, part of the built-in tag
 * taxonomy -- see `ClassificationAssignmentAdapter`) onto a specific object, optionally scoped
 * to one field, via `/ssot/data-governance/tag-assignments` (confirmed against the official
 * Connect REST API reference). `fieldName` requires `objectName` to also be set (the real API
 * rejects a field-only filter/assignment with `400 INVALID_INPUT_COMBINATION`).
 *
 * There is no PATCH endpoint for this resource -- changing which tag, object, or field an
 * assignment points at means deleting the old assignment and creating a new one. All three
 * fields are classified `'replace'` accordingly, same as `DataModelObjectMapping`.
 */
export class TagAssignmentAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'TagAssignment',
      resourcePlural: 'data-governance/tag-assignments',
      listResponseKey: 'tagAssignments',
      fieldClassification: {
        tagFullyQualifiedName: 'replace',
        objectName: 'replace',
        fieldName: 'replace',
      },
      buildLookupQuery: (key) => ({
        objectName: key.objectName as string | undefined,
        fieldName: key.fieldName as string | undefined,
        tagFullyQualifiedName: key.tagFullyQualifiedName as string | undefined,
      }),
      matchesLookupKey: (item, key) =>
        item.objectName === key.objectName &&
        item.fieldName === key.fieldName &&
        item.tagFullyQualifiedName === key.tagFullyQualifiedName,
    });
  }
}
