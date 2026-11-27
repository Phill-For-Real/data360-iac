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
import { AdapterContext, AdapterReadResult } from './types.js';
import { memberPath } from './real-paths.js';

/**
 * Field mappings from a Data Lake Object to a Data Model Object are their own real resource
 * (`/ssot/data-model-object-mappings`, see DataModelObjectMappingAdapter) -- not a property of
 * the DMO itself. The real `category` enum is uppercase (e.g. "PROFILE", "UNASSIGNED").
 *
 * **`GET /ssot/data-model-objects` (the collection list) defaults to `limit=50` and does not
 * return every DMO in the org** -- confirmed live: several real standard DMOs (e.g.
 * `ssot__Vehicle__dlm`, `ssot__ContactPointAddress__dlm`) were absent from the list even at
 * `limit=200`, yet resolve fine via the single-object endpoint,
 * `GET /ssot/data-model-objects/{dataModelObjectName}`. `lookup()` is overridden to use that
 * direct-by-name endpoint whenever the lookup key names a `name` (the common case for both
 * adoption detection and a `kind: "data"` block referencing a standard DMO), falling back to the
 * generic list-and-filter base behavior for any other lookup key shape.
 */
export class DataModelObjectAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'DataModelObject',
      resourcePlural: 'data-model-objects',
      // Confirmed real: the list response's array field is singular despite being an array.
      listResponseKey: 'dataModelObject',
      fieldClassification: {
        name: 'replace',
        category: 'replace',
        dataSpaceName: 'replace',
        label: 'update',
        description: 'update',
        fields: 'update',
      },
    });
  }

  public async lookup(ctx: AdapterContext, lookupKey: Record<string, unknown>): Promise<AdapterReadResult> {
    const name = lookupKey.name as string | undefined;
    if (!name) return super.lookup(ctx, lookupKey);

    const item = await ctx.client.request<Record<string, unknown> | null>({
      method: 'GET',
      path: memberPath(this.resourcePlural, name),
    });
    return item ? this.toReadResult(item) : undefined;
  }
}
