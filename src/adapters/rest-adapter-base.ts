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
import { AdapterContext, AdapterReadResult, FieldClassification, ResourceAdapter } from './types.js';
import { collectionPath, memberPath, withQuery, QueryParams } from './real-paths.js';

export type RestAdapterConfig = {
  type: string;
  /** The real Connect REST collection segment, e.g. "connections", "data-streams". */
  resourcePlural: string;
  fieldClassification: FieldClassification;
  /** HTTP method the real update endpoint uses. Most resources use PATCH; a few use PUT. */
  updateMethod?: 'PATCH' | 'PUT';
  /** Builds real query params for lookup(). Default: no params -- caller filters client-side. */
  buildLookupQuery?: (lookupKey: Record<string, unknown>) => QueryParams;
  /** Picks the matching item out of a listed collection for lookup(). Default: match on `name`. */
  matchesLookupKey?: (item: Record<string, unknown>, lookupKey: Record<string, unknown>) => boolean;
  /** The array field name in list responses, e.g. "connections", "dataStreams". */
  listResponseKey: string;
  /** Extracts {id, apiName, properties} from a raw item. Default: id/apiName from item.id/item.name. */
  toReadResult?: (item: Record<string, unknown>) => AdapterReadResult;
};

function defaultMatchesLookupKey(item: Record<string, unknown>, lookupKey: Record<string, unknown>): boolean {
  if (lookupKey.name !== undefined && item.name === lookupKey.name) return true;
  if (lookupKey.apiName !== undefined && item.apiName === lookupKey.apiName) return true;
  return false;
}

/**
 * `id` is Connect REST's own identifier, never a field a manifest declares as a property -- it's
 * excluded here so PlanEngine's desired-vs-live diff never sees a spurious, permanent "changed"
 * field for it. `name` stays: several real resources (Connection, DataStream, DataModelObject, ...)
 * declare `name` as a genuine, user-settable manifest property, compared field-by-field like any
 * other.
 */
function defaultToReadResult(item: Record<string, unknown>): AdapterReadResult {
  const { id, ...properties } = item;
  const name = item.name as string | number | undefined;
  return { id: String(id), apiName: name !== undefined ? String(name) : undefined, properties };
}

/**
 * Shared CRUD-over-Connect-REST scaffolding for a resource type, against the real Salesforce
 * Data 360 Connect REST API (base path /ssot/...). See API_NOTES.md for anything about a
 * given resource type that's still unverified (e.g. exact async-job terminal status values).
 */
export abstract class RestAdapterBase implements ResourceAdapter {
  public readonly type: string;
  public readonly deletionCapability = 'standalone' as const;
  public readonly fieldClassification: FieldClassification;
  protected readonly resourcePlural: string;
  protected readonly listResponseKey: string;
  protected readonly updateMethod: 'PATCH' | 'PUT';
  protected readonly buildLookupQuery: (lookupKey: Record<string, unknown>) => QueryParams;
  protected readonly matchesLookupKey: (item: Record<string, unknown>, lookupKey: Record<string, unknown>) => boolean;
  protected readonly toReadResult: (item: Record<string, unknown>) => AdapterReadResult;

  protected constructor(config: RestAdapterConfig) {
    this.type = config.type;
    this.resourcePlural = config.resourcePlural;
    this.fieldClassification = config.fieldClassification;
    this.listResponseKey = config.listResponseKey;
    this.updateMethod = config.updateMethod ?? 'PATCH';
    this.buildLookupQuery = config.buildLookupQuery ?? ((): QueryParams => ({}));
    this.matchesLookupKey = config.matchesLookupKey ?? defaultMatchesLookupKey;
    this.toReadResult = config.toReadResult ?? defaultToReadResult;
  }

  public async lookup(ctx: AdapterContext, lookupKey: Record<string, unknown>): Promise<AdapterReadResult> {
    const items = await this.list(ctx, this.buildLookupQuery(lookupKey));
    const matches = items.filter((item) => this.matchesLookupKey(item, lookupKey));
    if (matches.length > 1) throw new Error(`Ambiguous ${this.type} lookup`);
    const match = matches[0];
    return match ? this.toReadResult(match) : undefined;
  }

  public async read(ctx: AdapterContext, id: string): Promise<AdapterReadResult> {
    const item = await ctx.client.request<Record<string, unknown>>({
      method: 'GET',
      path: memberPath(this.resourcePlural, id),
    });
    return item ? this.toReadResult(item) : undefined;
  }

  public async create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    const item = await ctx.client.request<Record<string, unknown>>({
      method: 'POST',
      path: collectionPath(this.resourcePlural),
      body: properties,
    });
    return item ? this.toReadResult(item) : undefined;
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    const item = await ctx.client.request<Record<string, unknown>>({
      method: this.updateMethod,
      path: memberPath(this.resourcePlural, id),
      body: properties,
    });
    return item ? this.toReadResult(item) : undefined;
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    await ctx.client.request({ method: 'DELETE', path: memberPath(this.resourcePlural, id) });
  }

  protected async list(ctx: AdapterContext, query: QueryParams): Promise<Array<Record<string, unknown>>> {
    const response = await ctx.client.request<Record<string, unknown> | null | undefined>({
      method: 'GET',
      path: withQuery(collectionPath(this.resourcePlural), query),
    });
    const items = response?.[this.listResponseKey];
    return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
  }
}
