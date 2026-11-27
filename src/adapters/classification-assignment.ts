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
 * Links a governance classification (e.g. `Compliance_Classifications.PII`) to a governance tag
 * (e.g. `Compliance_Tags.PII.Email`) via `/ssot/data-governance/classification-assignments`
 * (confirmed against the official Connect REST API reference). Both the classification and tag
 * taxonomies ship real built-in entries (`DataCategorization.DataCompliance.{GDPR,HIPAA,CCPA,
 * PCIDSS}`, `DataCategorization.DataSensitivity.Restricted`, etc., observed live via `sf data360
 * discover`) -- a manifest only needs to reference these by fully-qualified name, no taxonomy
 * bootstrapping required for the common case.
 *
 * There is no PATCH endpoint for this resource, same as `TagAssignment` -- both fields are
 * classified `'replace'`.
 */
export class ClassificationAssignmentAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'ClassificationAssignment',
      resourcePlural: 'data-governance/classification-assignments',
      listResponseKey: 'classificationAssignments',
      fieldClassification: {
        classificationFullyQualifiedName: 'replace',
        tagFullyQualifiedName: 'replace',
      },
      buildLookupQuery: (key) => ({
        classificationFullyQualifiedName: key.classificationFullyQualifiedName as string | undefined,
        tagFullyQualifiedName: key.tagFullyQualifiedName as string | undefined,
      }),
      matchesLookupKey: (item, key) =>
        item.classificationFullyQualifiedName === key.classificationFullyQualifiedName &&
        item.tagFullyQualifiedName === key.tagFullyQualifiedName,
    });
  }
}
