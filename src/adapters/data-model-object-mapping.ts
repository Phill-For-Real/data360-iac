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
import { isRetryableConnectRestError } from '../connect-rest/client.js';
import { RestAdapterBase } from './rest-adapter-base.js';
import { AdapterContext, AdapterReadResult, DeletionObservation } from './types.js';
import { collectionPath, withQuery } from './real-paths.js';

/**
 * A DLO-to-DMO field mapping, its own real resource (`/ssot/data-model-object-mappings`).
 * `developerName` is server-generated on create -- there's no client-supplied id -- so it
 * doubles as both `id` and `apiName` here. Manifests reference the source/target by the DLO's
 * and DMO's real server-assigned `apiName` (their `name`), e.g.
 * `${DataLakeObject.x.apiName}` / `${DataModelObject.y.apiName}`.
 *
 * `POST /ssot/data-model-object-mappings` requires `dataspace` as a **query param** (confirmed
 * against the real API reference), not a body field -- `create()` is overridden to append it,
 * sourced from the block's `dataSpaceName` property and defaulting to `"default"` when absent
 * (matching the real endpoint's own documented default).
 *
 * Only the finer-grained `field-mappings` sub-endpoints support partial updates; this adapter
 * doesn't model those in v1, so every field is classified `replace` -- any change destroys and
 * recreates the whole mapping.
 */
export class DataModelObjectMappingAdapter extends RestAdapterBase {
  public readonly setLikePaths = ['fieldMapping'];
  public constructor() {
    super({
      type: 'DataModelObjectMapping',
      resourcePlural: 'data-model-object-mappings',
      listResponseKey: 'objectSourceTargetMaps',
      fieldClassification: {
        sourceEntityDeveloperName: 'replace',
        targetEntityDeveloperName: 'replace',
        fieldMapping: 'replace',
      },
      buildLookupQuery: (key) => ({
        dloDeveloperName: key.sourceEntityDeveloperName as string | undefined,
        dmoDeveloperName: key.targetEntityDeveloperName as string | undefined,
      }),
      matchesLookupKey: (item, key) =>
        item.sourceEntityDeveloperName === key.sourceEntityDeveloperName &&
        item.targetEntityDeveloperName === key.targetEntityDeveloperName,
      toReadResult: (item): AdapterReadResult => ({
        id: String(item.developerName),
        apiName: String(item.developerName),
        properties: item,
      }),
    });
  }

  private static matchesRequestedFields(item: Record<string, unknown>, properties: Record<string, unknown>): boolean {
    if (['DELETING', 'ERROR', 'FAILED'].includes(String(item.status))) return false;
    if (
      Object.keys(properties).some(
        (key) =>
          !['dataSpaceName', 'sourceEntityDeveloperName', 'targetEntityDeveloperName', 'fieldMapping'].includes(key)
      )
    )
      return false;
    const desired = properties.fieldMapping;
    const observed = item.fieldMappings ?? item.fieldMapping;
    if (!Array.isArray(desired) || !desired.length || !Array.isArray(observed)) return false;
    const pair = (mapping: Record<string, unknown>): string =>
      JSON.stringify([mapping.sourceFieldDeveloperName, mapping.targetFieldDeveloperName]);
    const wanted = new Set(desired.map((mapping: Record<string, unknown>) => pair(mapping)));
    const livePairs = observed.map((mapping: Record<string, unknown>) => pair(mapping));
    if (new Set(livePairs).size !== livePairs.length || ![...wanted].every((mapping) => livePairs.includes(mapping)))
      return false;
    // Only the metadata and key-qualifier pairs demonstrated in the verified GET examples
    // are allowed beyond the declared mapping. Other live configuration is a conflict.
    const generated = new Set([
      pair({ sourceFieldDeveloperName: 'DataSource__c', targetFieldDeveloperName: 'ssot__DataSourceId__c' }),
      pair({
        sourceFieldDeveloperName: 'DataSourceObject__c',
        targetFieldDeveloperName: 'ssot__DataSourceObjectId__c',
      }),
      pair({
        sourceFieldDeveloperName: 'InternalOrganization__c',
        targetFieldDeveloperName: 'ssot__InternalOrganizationId__c',
      }),
      ...desired.map((mapping: Record<string, unknown>) =>
        pair({
          sourceFieldDeveloperName: `KQ_${String(mapping.sourceFieldDeveloperName)}`,
          targetFieldDeveloperName: `KQ_${String(mapping.targetFieldDeveloperName).replace(/^ssot__/, '')}`,
        })
      ),
    ]);
    return livePairs.every((mapping) => wanted.has(mapping) || generated.has(mapping));
  }

  public async observeDeletion(ctx: AdapterContext, id: string): Promise<DeletionObservation> {
    try {
      const live = await this.read(ctx, id);
      if (!live) return { outcome: 'unknown' };
      const status = live.properties.status;
      return typeof status === 'string'
        ? { outcome: status.toUpperCase().includes('DELET') ? 'deleting' : 'present', status }
        : { outcome: 'present' };
    } catch (error) {
      if (ctx.journaled) throw error;
      const response = error as
        | { statusCode?: number; status?: number; name?: string; errorCode?: string; message?: string }
        | undefined;
      const status = response?.statusCode ?? response?.status;
      if (status === 404) return { outcome: 'absent' };
      if (status !== undefined) return { outcome: 'unknown' };
      const code = response?.errorCode ?? response?.name;
      return code === 'NOT_FOUND' &&
        response?.message?.trim() === `Object Source Target Map not found for the given name : ${id}`
        ? { outcome: 'absent' }
        : { outcome: 'unknown' };
    }
  }

  public async create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    const dataspace = (properties.dataSpaceName as string | undefined) ?? 'default';
    // Record the scoped identities before dispatch. A post-timeout lookup must not silently
    // claim a mapping that already existed before this operation.
    let before: Array<Record<string, unknown>> | undefined;
    try {
      before = await this.readScopedMappings(ctx, properties);
    } catch {
      /* unknown pre-operation evidence */
    }
    try {
      const item = await ctx.client.request<Record<string, unknown>>({
        method: 'POST',
        path: withQuery(collectionPath(this.resourcePlural), { dataspace }),
        body: properties,
      });
      return item ? this.toReadResult(item) : undefined;
    } catch (error) {
      if (ctx.journaled) throw error;
      if (!isRetryableConnectRestError(error) || before === undefined) throw error;
      try {
        const candidates = await this.readScopedMappings(ctx, properties);
        const candidate = candidates?.length === 1 ? candidates[0] : undefined;
        if (
          candidate &&
          !before.some((item) => item.developerName === candidate.developerName) &&
          DataModelObjectMappingAdapter.matchesRequestedFields(candidate, properties)
        )
          return this.toReadResult(candidate);
      } catch {
        /* preserve the create failure when read-only reconciliation is unavailable */
      }
      throw error;
    }
  }

  private async readScopedMappings(
    ctx: AdapterContext,
    properties: Record<string, unknown>
  ): Promise<Array<Record<string, unknown>> | undefined> {
    if (
      typeof properties.sourceEntityDeveloperName !== 'string' ||
      typeof properties.targetEntityDeveloperName !== 'string'
    )
      return undefined;
    const response = await ctx.client.request<Record<string, unknown>>({
      method: 'GET',
      path: withQuery(collectionPath(this.resourcePlural), {
        dataspace: (properties.dataSpaceName as string | undefined) ?? 'default',
        dloDeveloperName: properties.sourceEntityDeveloperName,
        dmoDeveloperName: properties.targetEntityDeveloperName,
      }),
    });
    // The verified scoped response is objectSourceTargetMaps. Pagination beyond this shape
    // has no verified contract here; an advertised continuation must remain unresolved.
    if (!Array.isArray(response.objectSourceTargetMaps) || response.nextPageUrl) return undefined;
    const items = response.objectSourceTargetMaps as Array<Record<string, unknown>>;
    if (typeof response.totalSize === 'number' && response.totalSize !== items.length) return undefined;
    if (
      !items.every(
        (item) =>
          typeof item.developerName === 'string' &&
          item.sourceEntityDeveloperName === properties.sourceEntityDeveloperName &&
          item.targetEntityDeveloperName === properties.targetEntityDeveloperName
      )
    )
      return undefined;
    return items;
  }
}
