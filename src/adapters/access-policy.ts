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
import { AdapterReadResult } from './types.js';

/**
 * A named container for field-level masking/access rules, `/ssot/data-governance/access-policies`
 * (confirmed against the official Connect REST API reference). `name` is the real, client-supplied
 * identifier (not server-generated) -- there's no separate numeric id in practice for this
 * plugin's purposes, so it doubles as both `id` and `apiName`, same pattern as
 * `CalculatedInsight`'s `apiName`.
 *
 * `rules` is intentionally **not** a property here -- the real `PATCH` on this resource only
 * updates `label`/`description` ("To modify rules, use the PUT rules endpoint instead", per the
 * spec); each rule is managed as its own resource by `AccessPolicyRule`, referencing this policy's
 * `name` via `${AccessPolicy.x.apiName}`. This mirrors `DataModelObjectMapping` being modeled
 * separately from `DataModelObject` rather than as a nested property.
 */
export class AccessPolicyAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'AccessPolicy',
      resourcePlural: 'data-governance/access-policies',
      listResponseKey: 'records',
      fieldClassification: {
        name: 'replace',
        label: 'update',
        description: 'update',
      },
      toReadResult: (item): AdapterReadResult => ({
        id: String(item.name),
        apiName: String(item.name),
        properties: item,
      }),
    });
  }
}
