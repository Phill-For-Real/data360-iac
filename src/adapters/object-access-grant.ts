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
import { collectionPath, memberPath, withQuery } from './real-paths.js';

const ID_DELIMITER = '::';

function encodeId(objectApiName: string, permissionSetName: string, dataSpaceName: string): string {
  return [objectApiName, permissionSetName, dataSpaceName].join(ID_DELIMITER);
}

function decodeId(id: string): { objectApiName: string; permissionSetName: string; dataSpaceName: string } {
  const [objectApiName, permissionSetName, dataSpaceName] = id.split(ID_DELIMITER);
  return { objectApiName, permissionSetName, dataSpaceName };
}

function toReadResult(item: Record<string, unknown>): AdapterReadResult {
  const objectApiName = String(item.objectApiName);
  const permissionSetName = String(item.permissionSetName);
  const dataSpaceName = typeof item.dataSpaceName === 'string' ? item.dataSpaceName : 'default';
  const id = encodeId(objectApiName, permissionSetName, dataSpaceName);
  return { id, apiName: id, properties: item };
}

/**
 * Grants a permission set access to a Data Cloud object (DMO/DLO/CalculatedInsight) and data
 * space via `/ssot/data-governance/object-access-grants` (confirmed against the official Connect
 * REST API reference). Create is documented as idempotent: posting an already-existing
 * `(objectApiName, permissionSetName, dataSpaceName)` triple returns the existing grant rather
 * than erroring.
 *
 * The real resource has **no server-generated id at all** -- its paths and natural key are the
 * `(objectApiName, permissionSetName, dataSpaceName)` triple itself (`GET`/`DELETE` are keyed by
 * `objectApiName` in the path plus the other two as query params). This adapter synthesizes a
 * composite `id`/`apiName` by joining the triple with `::`, consistent with how `Segment` and
 * `CalculatedInsight` each paper over a real-API identity mismatch with a custom `toReadResult`.
 *
 * There is no PATCH endpoint -- all three fields are classified `'replace'`; any change destroys
 * and recreates the grant (same reasoning as `TagAssignment`/`ClassificationAssignment`).
 */
export class ObjectAccessGrantAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'ObjectAccessGrant',
      resourcePlural: 'data-governance/object-access-grants',
      listResponseKey: 'grants',
      fieldClassification: {
        objectApiName: 'replace',
        permissionSetName: 'replace',
        dataSpaceName: 'replace',
      },
      buildLookupQuery: (key) => ({
        objectApiName: key.objectApiName as string | undefined,
        permissionSetName: key.permissionSetName as string | undefined,
      }),
      matchesLookupKey: (item, key) => {
        const itemDataSpace = typeof item.dataSpaceName === 'string' ? item.dataSpaceName : 'default';
        const keyDataSpace = typeof key.dataSpaceName === 'string' ? key.dataSpaceName : 'default';
        return (
          item.objectApiName === key.objectApiName &&
          item.permissionSetName === key.permissionSetName &&
          itemDataSpace === keyDataSpace
        );
      },
      toReadResult,
    });
  }

  public async create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    const item = await ctx.client.request<Record<string, unknown>>({
      method: 'POST',
      path: collectionPath(this.resourcePlural),
      body: properties,
    });
    return item ? toReadResult(item) : undefined;
  }

  public async read(ctx: AdapterContext, id: string): Promise<AdapterReadResult> {
    const { objectApiName, permissionSetName, dataSpaceName } = decodeId(id);
    const item = await ctx.client.request<Record<string, unknown>>({
      method: 'GET',
      path: withQuery(memberPath(this.resourcePlural, objectApiName), { permissionSetName, dataSpaceName }),
    });
    return item ? toReadResult(item) : undefined;
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    const { objectApiName, permissionSetName, dataSpaceName } = decodeId(id);
    await ctx.client.request({
      method: 'DELETE',
      path: withQuery(memberPath(this.resourcePlural, objectApiName), { permissionSetName, dataSpaceName }),
    });
  }
}
