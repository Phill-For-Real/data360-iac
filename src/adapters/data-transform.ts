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
 * The real update endpoint for this resource is PUT, not PATCH. `definition` is passed through
 * untouched.
 *
 * **`type: "BATCH"` requires `definition.type: "STL"` (a node-graph), not `"SQL"`** -- confirmed
 * live: a `BATCH` transform submitted with `definition.type: "SQL"` fails with `Expect either
 * STL or DCSQL definition type with Batch type`; the Redoc spec's only documented `"SQL"` example
 * is for `type: "Streaming"`, a different resource type than `"BATCH"`. The real STL shape is
 * `definition.nodes`, an object keyed by arbitrary node names, each either a `load` node
 * (`parameters.dataset: {name, type: "dataLakeObject"}`, `parameters.fields: [<real field names>]`)
 * or an `outputD360` node (`parameters.name`: the output DLO's real name, `parameters.
 * fieldsMappings: [{sourceField, targetField}]`, `parameters.sources`: the upstream node names).
 *
 * **The output DLO named in an `outputD360` node must already exist live** -- confirmed live,
 * including against the Redoc spec's own verbatim example payload (reproduced exactly against
 * this org): `INVALID_INPUT: Data Lake Object name <name> neither exists nor can be created.`
 * It is not auto-created as a side effect of the transform the way a `DataStream`'s `DataLakeObject`
 * is -- a manifest needs a separate `kind: "resource" DataLakeObject` block for it, referenced
 * from the node's `parameters.name` via `${DataLakeObject.x.apiName}` so the dependency graph
 * orders it before the `DataTransform` automatically.
 *
 * No async job in v1: `actions/run` has no jobId and no dedicated poll endpoint, only a
 * `run-history` list; nothing in this plugin's lifecycle requires triggering a run.
 */
export class DataTransformAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'DataTransform',
      resourcePlural: 'data-transforms',
      listResponseKey: 'dataTransforms',
      updateMethod: 'PUT',
      fieldClassification: {
        type: 'replace',
        name: 'replace',
        definition: 'update',
        label: 'update',
      },
    });
  }
}
