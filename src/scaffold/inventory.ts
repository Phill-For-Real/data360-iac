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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterContext } from '../adapters/types.js';
import { DISCOVER_ENDPOINTS } from '../discover/endpoints.js';
import { memberPath } from '../adapters/real-paths.js';
import { getAdapter } from '../adapters/registry.js';
export type InventoryItem = { type: string; identity: string; observed: Record<string, unknown> };
export type Inventory = {
  items: InventoryItem[];
  limits: string[];
  source: { mode: 'offline' | 'live'; orgId?: string; dataSpace?: string };
};
export const INVENTORIES: Record<string, { file: string; plural: string; array: string }> = {
  Connection: { file: 'connections', plural: 'connections', array: 'connections' },
  DataStream: { file: 'data-streams', plural: 'data-streams', array: 'dataStreams' },
  DataLakeObject: { file: 'data-lake-objects', plural: 'data-lake-objects', array: 'dataLakeObjects' },
  DataModelObject: { file: 'data-model-objects', plural: 'data-model-objects', array: 'dataModelObject' },
  DataModelObjectMapping: {
    file: 'data-model-object-mappings',
    plural: 'data-model-object-mappings',
    array: 'objectSourceTargetMaps',
  },
  CalculatedInsight: { file: 'calculated-insights', plural: 'calculated-insights', array: 'collection.items' },
  IdentityResolutionRuleset: {
    file: 'identity-resolutions',
    plural: 'identity-resolutions',
    array: 'identityResolutions',
  },
  Activation: { file: 'activations', plural: 'activations', array: 'activations' },
  Segment: { file: 'segments', plural: 'segments', array: 'segments' },
  ActivationTarget: { file: 'activation-targets', plural: 'activation-targets', array: 'activationTargets' },
  AccessPolicy: { file: 'access-policies', plural: 'data-governance/access-policies', array: 'records' },
};
function arrayAt(body: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined),
      body
    );
}
export function observedIdentity(type: string, item: Record<string, unknown>): string | undefined {
  const id =
    type === 'DataStream'
      ? item.recordId
      : type === 'CalculatedInsight'
      ? item.apiName
      : type === 'DataModelObjectMapping'
      ? item.developerName
      : type === 'AccessPolicyRule'
      ? `${String(item.policyName)}::${String(item.name)}`
      : item.id ?? item.name;
  return typeof id === 'string' && id.length ? id : undefined;
}
// eslint-disable-next-line complexity -- distinguish verified collection, fan-out, scoped rules and incomplete inventories.
export function addInventory(inventory: Inventory, type: string, body: unknown): void {
  const config = INVENTORIES[type];
  if (
    type === 'DataModelObjectMapping' &&
    body &&
    typeof body === 'object' &&
    !Array.isArray((body as Record<string, unknown>).objectSourceTargetMaps)
  ) {
    const scoped = Object.values(body).filter(
      (value) =>
        value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).objectSourceTargetMaps)
    );
    if (scoped.length) {
      inventory.limits.push(
        'DataModelObjectMapping: discovery fan-out covers discovered DMO query scopes, not a complete mapping inventory.'
      );
      for (const page of scoped) addInventory(inventory, type, page);
      if (Object.values(body).some((value) => value && typeof value === 'object' && '__error' in value))
        inventory.limits.push('DataModelObjectMapping: a scoped discovery request failed.');
      return;
    }
  }
  const array = arrayAt(body, config.array);
  if (!Array.isArray(array)) {
    inventory.limits.push(`${type}: unsupported collection envelope`);
    return;
  }
  const envelope = body as Record<string, unknown>;
  const collection = envelope.collection as Record<string, unknown> | undefined;
  const total = envelope.totalSize ?? collection?.totalSize;
  if (envelope.nextPageUrl || collection?.nextPageUrl || typeof total !== 'number' || total !== array.length)
    inventory.limits.push(
      `${type}: inventory completeness is unknown or partial; collection absence is not authoritative`
    );
  for (const value of array) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const identity = observedIdentity(type, item);
    if (identity) inventory.items.push({ type, identity, observed: item });
    if (type === 'AccessPolicy' && Array.isArray(item.rules))
      for (const rule of item.rules as Array<Record<string, unknown>>) {
        const observed = { ...rule, policyName: item.name };
        inventory.items.push({
          type: 'AccessPolicyRule',
          identity: observedIdentity('AccessPolicyRule', observed)!,
          observed,
        });
      }
  }
}
export async function offlineInventory(directory: string): Promise<Inventory> {
  const inventory: Inventory = {
    items: [],
    limits: ['Snapshot source org and discovery scope may be unknown. No complete org inventory is inferred.'],
    source: { mode: 'offline' },
  };
  let statuses: Map<string, string> | undefined;
  try {
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as Array<{
      fileName?: string;
      status?: string;
      path?: string;
    }>;
    if (!Array.isArray(summary)) throw new Error('Unsupported summary shape');
    statuses = new Map(
      summary
        .filter((e) => typeof e.fileName === 'string' && typeof e.status === 'string')
        .map((e) => [e.fileName!, e.status!])
    );
    inventory.limits.push(
      `Discovery summary covers ${summary.length} endpoint results; source query scope and completeness are not inferred.`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      // eslint-disable-next-line preserve-caught-error -- raw parse errors may expose snapshot secret values.
      throw new Error('Invalid discovery summary; contents omitted.');
  }
  // Read only the existing discover command's known files; never follow snapshot paths or use auth.
  for (const [type, config] of Object.entries(INVENTORIES)) {
    const endpoint = DISCOVER_ENDPOINTS.find((e) => e.fileName === config.file);
    if (!endpoint) continue;
    if (statuses && statuses.get(config.file) !== 'fetched') {
      inventory.limits.push(`${type}: summary does not mark this snapshot as fetched; stale files are ignored`);
      continue;
    }
    try {
      const body: unknown = JSON.parse(
        // eslint-disable-next-line no-await-in-loop -- known local snapshot files only.
        await readFile(join(directory, endpoint.folder, `${endpoint.fileName}.json`), 'utf8')
      );
      addInventory(inventory, type, body);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        // eslint-disable-next-line preserve-caught-error -- a raw parse error could expose snapshot credentials.
        throw new Error(`Invalid discovery file for ${type}; source contents were not logged.`);
      inventory.limits.push(`${type}: snapshot file unavailable`);
    }
  }
  try {
    const metadata = JSON.parse(await readFile(join(directory, 'source.json'), 'utf8')) as {
      orgId?: string;
      dataSpace?: string;
    };
    if (typeof metadata.orgId === 'string') inventory.source.orgId = metadata.orgId;
    if (typeof metadata.dataSpace === 'string') inventory.source.dataSpace = metadata.dataSpace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      // eslint-disable-next-line preserve-caught-error -- raw metadata parse errors can expose credentials.
      throw new Error('Invalid snapshot source metadata; contents omitted.');
  }
  return inventory;
}
export async function liveInventory(ctx: AdapterContext, orgId: string, dataSpace: string): Promise<Inventory> {
  const inventory: Inventory = {
    items: [],
    limits: ['Live collection scope is limited to readable endpoints; no complete org inventory is inferred.'],
    source: { mode: 'live', orgId, dataSpace },
  };
  for (const [type, config] of Object.entries(INVENTORIES).filter(
    ([kind]) => kind !== 'Connection' && kind !== 'DataModelObjectMapping'
  )) {
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded read-only inventory.
      addInventory(inventory, type, await ctx.client.request({ method: 'GET', path: `/ssot/${config.plural}` }));
    } catch {
      inventory.limits.push(`${type}: inventory unavailable`);
    }
  }
  for (const parent of [...inventory.items].filter((i) => i.type === 'AccessPolicy')) {
    try {
      // eslint-disable-next-line no-await-in-loop -- verified parent member GET exposes complete readable rule configuration.
      const observed = await ctx.client.request<Record<string, unknown>>({
        method: 'GET',
        path: memberPath('data-governance/access-policies', parent.identity),
      });
      inventory.items = inventory.items.filter(
        (i) =>
          !(i.type === 'AccessPolicy' && i.identity === parent.identity) &&
          !(i.type === 'AccessPolicyRule' && i.observed.policyName === parent.identity)
      );
      addInventory(inventory, 'AccessPolicy', { records: [observed] });
    } catch {
      inventory.limits.push('AccessPolicy: full parent/rule configuration is unavailable.');
    }
  }
  // IngestApi is the supported connection source, not a claim of exhaustive connector inventory.
  try {
    addInventory(
      inventory,
      'Connection',
      await ctx.client.request({ method: 'GET', path: '/ssot/connections?connectorType=IngestApi' })
    );
  } catch {
    inventory.limits.push('Connection: IngestApi inventory unavailable');
  }
  for (const dlo of inventory.items.filter((i) => i.type === 'DataLakeObject')) {
    try {
      addInventory(
        inventory,
        'DataModelObjectMapping',
        // eslint-disable-next-line no-await-in-loop -- verified scoped inventory reads are sequential.
        await ctx.client.request({
          method: 'GET',
          path: `/ssot/data-model-object-mappings?dloDeveloperName=${encodeURIComponent(String(dlo.observed.name))}`,
        })
      );
    } catch {
      inventory.limits.push('DataModelObjectMapping: source inventory unavailable');
    }
  }
  return inventory;
}
export async function directDmo(inventory: Inventory, name: string, ctx?: AdapterContext): Promise<void> {
  if (!ctx || inventory.items.some((i) => i.type === 'DataModelObject' && i.observed.name === name)) return;
  try {
    const result = await getAdapter('DataModelObject').lookup(ctx, { name });
    if (result)
      inventory.items.push({
        type: 'DataModelObject',
        identity: result.id,
        observed: { ...result.properties, id: result.id },
      });
  } catch {
    inventory.limits.push('DataModelObject: direct lookup unavailable');
  }
}
