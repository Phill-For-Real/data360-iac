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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memberPath } from '../adapters/real-paths.js';
import { AdapterContext } from '../adapters/types.js';
import { ConcurrencyLimiter } from '../execution/concurrency-limiter.js';
import { DiscoverEndpoint, DiscoveryStage, DISCOVERY_STAGES, EntitySource } from './endpoints.js';

export type DiscoverEndpointResult = {
  folder: string;
  fileName: string;
  path: string;
  status: 'fetched' | 'skipped' | 'error';
  /**
   * Best-effort: the length of the first array found anywhere in the written response body (or,
   * for a fanned-out endpoint, the number of discovered entities it was queried once per).
   */
  itemCount?: number;
  skipReason?: string;
  error?: string;
  filePath?: string;
};

/** Called once per endpoint as soon as its outcome is known, so a caller can report live progress. */
export type DiscoverProgressCallback = (result: DiscoverEndpointResult) => void;

const CONNECTORS_PATH = '/ssot/connectors';
const CONNECTIONS_PATH = '/ssot/connections';
const DATA_STREAMS_PATH = '/ssot/data-streams';
const METADATA_ENTITIES_PATH = '/ssot/metadata-entities';
const DATA_MODEL_OBJECTS_PATH = '/ssot/data-model-objects';
const DATA_SPACES_PATH = '/ssot/data-spaces';
const ACTIVATION_PLATFORMS_PATH = '/ssot/activation-platforms';
const ACTIVATION_TARGETS_PATH = '/ssot/activation-targets';
const CONFIGURED_MODELS_PATH = '/ssot/machine-learning/configured-models';
const MODEL_ARTIFACTS_PATH = '/ssot/machine-learning/model-artifacts';

/** Safety cap so a malformed or looping nextPageUrl can never hang a discovery run forever. */
const MAX_PAGES = 200;

function firstArrayLength(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const found = firstArrayLength(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Finds the first array-valued property anywhere in `value`, returning the path of keys to reach it. */
function findFirstArrayPath(value: unknown, path: string[] = []): string[] | undefined {
  if (Array.isArray(value)) return path;
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const found = findFirstArrayPath(nested, [...path, key]);
      if (found) return found;
    }
  }
  return undefined;
}

function getAtPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    value
  );
}

function setAtPath(value: Record<string, unknown>, path: string[], newValue: unknown): void {
  let cursor: Record<string, unknown> = value;
  for (let i = 0; i < path.length - 1; i++) {
    cursor = cursor[path[i]] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = newValue;
}

/**
 * Real Connect REST list responses expose their next-page link one of two ways, both observed
 * live: a top-level `nextPageUrl`, or one nested under a `collection` envelope (only
 * calculated-insights does this). Returns the link and where to look for it next time, or
 * undefined once there's no more to fetch.
 */
function findNextPageUrl(body: unknown): { url: string; collectionNested: boolean } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.nextPageUrl === 'string' && record.nextPageUrl.length > 0) {
    return { url: record.nextPageUrl, collectionNested: false };
  }
  const collection = record.collection;
  if (collection && typeof collection === 'object') {
    const nextPageUrl = (collection as Record<string, unknown>).nextPageUrl;
    if (typeof nextPageUrl === 'string' && nextPageUrl.length > 0) {
      return { url: nextPageUrl, collectionNested: true };
    }
  }
  return undefined;
}

/**
 * Follows `nextPageUrl` until exhausted, merging every page's array onto the first page's array
 * in place. Every real `nextPageUrl` example is already a full `/services/data/vNN.N/ssot/...`
 * path, and @salesforce/core's underlying jsforce Connection passes such paths straight through
 * unmodified (see `_normalizeUrl` in `@jsforce/jsforce-node`), so no URL-building is needed here
 * -- it's requested exactly as the org returned it.
 */
async function followPagination(ctx: AdapterContext, initialBody: unknown): Promise<unknown> {
  let body = initialBody;
  let next = findNextPageUrl(body);
  if (!next) return body;

  const arrayPath = next.collectionNested
    ? findFirstArrayPath(getAtPath(body, ['collection']))
    : findFirstArrayPath(body);
  if (!arrayPath) return body;

  const fullArrayPath = next.collectionNested ? ['collection', ...arrayPath] : arrayPath;
  const merged = [...((getAtPath(body, fullArrayPath) as unknown[]) ?? [])];

  for (let page = 0; page < MAX_PAGES && next; page++) {
    // eslint-disable-next-line no-await-in-loop -- each page's URL depends on the previous page's response.
    const pageBody = await ctx.client.request({ method: 'GET', path: next.url });
    const pageArrayPath = next.collectionNested
      ? findFirstArrayPath(getAtPath(pageBody, ['collection']))
      : findFirstArrayPath(pageBody);
    const pageFullArrayPath = next.collectionNested && pageArrayPath ? ['collection', ...pageArrayPath] : pageArrayPath;
    if (pageFullArrayPath) {
      merged.push(...((getAtPath(pageBody, pageFullArrayPath) as unknown[]) ?? []));
    }
    body = pageBody;
    next = findNextPageUrl(body);
  }

  const result = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {};
  setAtPath(result, fullArrayPath, merged);
  return result;
}

async function writeJson(outputDir: string, folder: string, fileName: string, body: unknown): Promise<string> {
  const folderPath = join(outputDir, folder);
  await mkdir(folderPath, { recursive: true });
  const filePath = join(folderPath, `${fileName}.json`);
  await writeFile(filePath, JSON.stringify(body, null, 2));
  return filePath;
}

async function fetchAndWrite(
  ctx: AdapterContext,
  outputDir: string,
  endpoint: DiscoverEndpoint,
  onProgress?: DiscoverProgressCallback
): Promise<{ result: DiscoverEndpointResult; body?: unknown }> {
  try {
    const firstPage = await ctx.client.request({ method: 'GET', path: endpoint.path });
    const body = await followPagination(ctx, firstPage);
    if (endpoint.path === '/ssot/data-governance/access-policies' && body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      if (Array.isArray(record.records))
        record.records = await Promise.all(
          record.records.map(async (policy: Record<string, unknown>) => {
            if (typeof policy.name !== 'string') return policy;
            try {
              return await ctx.client.request({
                method: 'GET',
                path: memberPath('data-governance/access-policies', policy.name),
              });
            } catch {
              return { ...policy, configurationReadError: true };
            }
          })
        );
    }
    const filePath = await writeJson(outputDir, endpoint.folder, endpoint.fileName, body);
    const result: DiscoverEndpointResult = {
      folder: endpoint.folder,
      fileName: endpoint.fileName,
      path: endpoint.path,
      status: 'fetched',
      itemCount: firstArrayLength(body),
      filePath,
    };
    onProgress?.(result);
    return { body, result };
  } catch (e) {
    const result: DiscoverEndpointResult = {
      folder: endpoint.folder,
      fileName: endpoint.fileName,
      path: endpoint.path,
      status: 'error',
      error: (e as Error).message,
    };
    onProgress?.(result);
    return { result };
  }
}

/**
 * Calls a `dependsOn`-bearing endpoint once per discovered entity value, concurrency-limited,
 * and writes one file whose top-level shape is a dictionary keyed by that value --
 * `{ "<entityValue>": <responseBody>, ... }` -- so it's clear which entity each result came
 * from. A per-entity request failure is recorded under its own key (`{ "__error": "..." }`)
 * rather than failing the whole endpoint.
 */
async function fetchFanOut(
  ctx: AdapterContext,
  outputDir: string,
  endpoint: DiscoverEndpoint,
  values: string[],
  limiter: ConcurrencyLimiter,
  onProgress?: DiscoverProgressCallback
): Promise<DiscoverEndpointResult> {
  const { param } = endpoint.dependsOn!;
  const dict: Record<string, unknown> = {};

  await Promise.all(
    values.map((value) =>
      limiter.run(async () => {
        try {
          const firstPage = await ctx.client.request({
            method: 'GET',
            path: `${endpoint.path}?${param}=${encodeURIComponent(value)}`,
          });
          dict[value] = await followPagination(ctx, firstPage);
        } catch (e) {
          dict[value] = { __error: (e as Error).message };
        }
      })
    )
  );

  const filePath = await writeJson(outputDir, endpoint.folder, endpoint.fileName, dict);
  const result: DiscoverEndpointResult = {
    folder: endpoint.folder,
    fileName: endpoint.fileName,
    path: endpoint.path,
    status: 'fetched',
    itemCount: values.length,
    filePath,
  };
  onProgress?.(result);
  return result;
}

function skippedResult(endpoint: DiscoverEndpoint): DiscoverEndpointResult {
  return {
    folder: endpoint.folder,
    fileName: endpoint.fileName,
    path: endpoint.path,
    status: 'skipped',
    skipReason: endpoint.skipReason,
  };
}

function connectorTypesFromCatalog(connectorsBody: unknown): string[] {
  return ((connectorsBody as { connectorInfoList?: Array<{ name?: string }> } | undefined)?.connectorInfoList ?? [])
    .map((c) => c.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * `GET /ssot/connectors` is a static catalog of connector types available to *create* in this
 * org, not the set of types actually in use -- a connection can exist with a connectorType the
 * catalog never lists (confirmed live: an org's `IngestApi`/`MarketingDataConnector`/
 * `UploadedFiles` connections didn't appear in its connectors catalog at all). Every fetched Data
 * Stream carries its owning connection's real connectorType in `connectorInfo.connectorType`, so
 * that's unioned in as a second, usage-based source of connector types.
 */
function connectorTypesFromDataStreams(dataStreamsBody: unknown): string[] {
  const streams =
    (dataStreamsBody as { dataStreams?: Array<{ connectorInfo?: { connectorType?: string } }> } | undefined)
      ?.dataStreams ?? [];
  return streams.map((s) => s.connectorInfo?.connectorType).filter((type): type is string => typeof type === 'string');
}

/**
 * `GET /ssot/connections` requires `connectorType` as a query param (see ConnectionAdapter) --
 * there's no single "list every connection" call. This enumerates every real connector type seen
 * either in the connectors catalog or in use by an already-fetched Data Stream, then loops a
 * `connections` fetch per type (itself paginated), merging every result into one combined file so
 * the Connections folder still reads as a single "all connections" snapshot.
 */
async function discoverConnections(
  ctx: AdapterContext,
  outputDir: string,
  connectionsEndpoint: DiscoverEndpoint,
  connectorsFetched: boolean,
  connectorsBody: unknown,
  dataStreamsBody: unknown,
  onProgress?: DiscoverProgressCallback
): Promise<DiscoverEndpointResult> {
  if (!connectorsFetched) {
    const result: DiscoverEndpointResult = {
      folder: connectionsEndpoint.folder,
      fileName: connectionsEndpoint.fileName,
      path: CONNECTIONS_PATH,
      status: 'error',
      error: 'could not enumerate connector types: GET /ssot/connectors failed',
    };
    onProgress?.(result);
    return result;
  }

  const connectorTypes = [
    ...new Set([...connectorTypesFromCatalog(connectorsBody), ...connectorTypesFromDataStreams(dataStreamsBody)]),
  ];

  try {
    const connections: Array<Record<string, unknown>> = [];
    for (const connectorType of connectorTypes) {
      // eslint-disable-next-line no-await-in-loop -- bounded by the org's own connector-type count, sequential for a predictable request rate.
      const firstPage = await ctx.client.request<{ connections?: Array<Record<string, unknown>> }>({
        method: 'GET',
        path: `${CONNECTIONS_PATH}?connectorType=${encodeURIComponent(connectorType)}`,
      });
      // eslint-disable-next-line no-await-in-loop -- see above.
      const page = (await followPagination(ctx, firstPage)) as { connections?: Array<Record<string, unknown>> };
      connections.push(...(page?.connections ?? []));
    }

    const filePath = await writeJson(outputDir, connectionsEndpoint.folder, connectionsEndpoint.fileName, {
      connections,
    });
    const result: DiscoverEndpointResult = {
      folder: connectionsEndpoint.folder,
      fileName: connectionsEndpoint.fileName,
      path: CONNECTIONS_PATH,
      status: 'fetched',
      itemCount: connections.length,
      filePath,
    };
    onProgress?.(result);
    return result;
  } catch (e) {
    const result: DiscoverEndpointResult = {
      folder: connectionsEndpoint.folder,
      fileName: connectionsEndpoint.fileName,
      path: CONNECTIONS_PATH,
      status: 'error',
      error: (e as Error).message,
    };
    onProgress?.(result);
    return result;
  }
}

/** Real names/ids discovered from earlier stages' bodies, accumulated as each stage completes. */
type EntityRegistry = Record<EntitySource, string[]>;

function emptyRegistry(): EntityRegistry {
  return { dmoNames: [], dataSpaceNames: [], activationTargetIds: [], activationPlatformIds: [], modelIds: [] };
}

function stringsAt(body: unknown, arrayPath: string[], field: string): string[] {
  const array = getAtPath(body, arrayPath);
  if (!Array.isArray(array)) return [];
  return array
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[field] : undefined))
    .filter((value): value is string => typeof value === 'string');
}

/**
 * Updates the entity registry from whatever bodies this stage's endpoints fetched, keyed by
 * path. Each extraction is additive (deduped via Set at the end) so multiple sources can
 * contribute to the same list, e.g. both Metadata and Data Model Objects contribute DMO names.
 */
function updateRegistry(registry: EntityRegistry, bodiesByPath: Map<string, unknown>): EntityRegistry {
  const dmoNamesFromMetadata = (
    (getAtPath(bodiesByPath.get(METADATA_ENTITIES_PATH), ['metadata']) as
      | Array<{ type?: string; name?: string }>
      | undefined) ?? []
  )
    .filter((entity) => entity.type === 'DataModelObject')
    .map((entity) => entity.name)
    .filter((name): name is string => typeof name === 'string');

  const dmoNamesFromDataModelObjects = stringsAt(
    bodiesByPath.get(DATA_MODEL_OBJECTS_PATH),
    ['dataModelObject'],
    'name'
  );
  const dataSpaceNames = stringsAt(bodiesByPath.get(DATA_SPACES_PATH), ['dataSpaces'], 'name');
  const activationPlatformIds = [
    ...stringsAt(bodiesByPath.get(ACTIVATION_PLATFORMS_PATH), ['activationPlatforms'], 'id'),
    ...stringsAt(bodiesByPath.get(ACTIVATION_PLATFORMS_PATH), ['activationPlatforms'], 'name'),
  ];
  const activationTargetIds = stringsAt(bodiesByPath.get(ACTIVATION_TARGETS_PATH), ['activationTargets'], 'id');
  const modelIds = [
    ...stringsAt(bodiesByPath.get(CONFIGURED_MODELS_PATH), ['configuredModels'], 'name'),
    ...stringsAt(bodiesByPath.get(MODEL_ARTIFACTS_PATH), ['modelArtifacts'], 'name'),
  ];

  return {
    dmoNames: [...new Set([...registry.dmoNames, ...dmoNamesFromMetadata, ...dmoNamesFromDataModelObjects])],
    dataSpaceNames: [...new Set([...registry.dataSpaceNames, ...dataSpaceNames])],
    activationTargetIds: [...new Set([...registry.activationTargetIds, ...activationTargetIds])],
    activationPlatformIds: [...new Set([...registry.activationPlatformIds, ...activationPlatformIds])],
    modelIds: [...new Set([...registry.modelIds, ...modelIds])],
  };
}

async function runStage(
  ctx: AdapterContext,
  outputDir: string,
  stage: DiscoveryStage,
  registry: EntityRegistry,
  limiter: ConcurrencyLimiter,
  onProgress?: DiscoverProgressCallback
): Promise<{ results: DiscoverEndpointResult[]; bodiesByPath: Map<string, unknown> }> {
  const bodiesByPath = new Map<string, unknown>();
  const results: DiscoverEndpointResult[] = [];

  const skipped = stage.endpoints.filter((e) => e.skipReason);
  for (const endpoint of skipped) {
    const result = skippedResult(endpoint);
    onProgress?.(result);
    results.push(result);
  }

  // Connections is handled as a dedicated step (see discoverConnections) since it has no
  // "list all" of its own -- it's excluded from the plain fetch batch below and run after.
  const plain = stage.endpoints.filter((e) => !e.skipReason && !e.dependsOn && e.path !== CONNECTIONS_PATH);
  const fetchedPlain = await Promise.all(
    plain.map((endpoint) =>
      limiter.run(async () => {
        const { result, body } = await fetchAndWrite(ctx, outputDir, endpoint, onProgress);
        bodiesByPath.set(endpoint.path, body);
        return result;
      })
    )
  );
  results.push(...fetchedPlain);

  const connectionsEndpoint = stage.endpoints.find((e) => e.path === CONNECTIONS_PATH);
  if (connectionsEndpoint) {
    const connectorsResult = fetchedPlain.find((r) => r.path === CONNECTORS_PATH);
    const connectionsResult = await limiter.run(() =>
      discoverConnections(
        ctx,
        outputDir,
        connectionsEndpoint,
        connectorsResult?.status === 'fetched',
        bodiesByPath.get(CONNECTORS_PATH),
        bodiesByPath.get(DATA_STREAMS_PATH),
        onProgress
      )
    );
    results.push(connectionsResult);
  }

  const fanOut = stage.endpoints.filter((e) => e.dependsOn);
  for (const endpoint of fanOut) {
    const values = registry[endpoint.dependsOn!.source];
    // eslint-disable-next-line no-await-in-loop -- each fan-out endpoint's own calls are already concurrency-limited.
    const result = await fetchFanOut(ctx, outputDir, endpoint, values, limiter, onProgress);
    results.push(result);
  }

  return { results, bodiesByPath };
}

/**
 * Snapshots every list-able Connect REST GET endpoint (no required path/query param beyond what
 * has a documented default, or one this command can resolve from an earlier stage's results) to
 * `<outputDir>/<folder>/<fileName>.json`, plus a `summary.json` recording every endpoint's
 * outcome. Runs in dependency order, not alphabetically (see `DISCOVERY_STAGES` in
 * `endpoints.js`): Metadata and Data Spaces first (they name every DMO/data space in the org),
 * then Connections, then the rest, with endpoints that require a real entity id/name (DMO,
 * activation target/platform, model) fanning out over every value discovered so far instead of
 * erroring on a missing required param. Every endpoint is fully paginated (see
 * followPagination) before being written.
 *
 * `onProgress`, when supplied, is called the instant each endpoint's outcome is known (skipped
 * endpoints report immediately, before any network activity starts) -- callers use this to print
 * live status rather than waiting for the whole run to finish.
 */
export async function runDiscovery(
  ctx: AdapterContext,
  outputDir: string,
  onProgress?: DiscoverProgressCallback,
  concurrency = 5,
  source?: { orgId: string; dataSpace: string }
): Promise<DiscoverEndpointResult[]> {
  const limiter = new ConcurrencyLimiter(concurrency);
  let registry = emptyRegistry();
  const results: DiscoverEndpointResult[] = [];

  for (const stage of DISCOVERY_STAGES) {
    // eslint-disable-next-line no-await-in-loop -- stages are intentionally sequential: later stages fan out over entities discovered by earlier ones.
    const { results: stageResults, bodiesByPath } = await runStage(
      ctx,
      outputDir,
      stage,
      registry,
      limiter,
      onProgress
    );
    results.push(...stageResults);
    registry = updateRegistry(registry, bodiesByPath);
  }

  await writeFile(join(outputDir, 'summary.json'), JSON.stringify(results, null, 2));
  if (source) await writeFile(join(outputDir, 'source.json'), JSON.stringify(source, null, 2));
  return results;
}
