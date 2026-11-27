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
import { AdapterContext, AdapterReadResult } from './types.js';
import { collectionPath, memberPath, withQuery } from './real-paths.js';

type FieldInput = { name: string; label?: string; dataType: string; isPrimaryKey?: boolean };

/**
 * Create embeds and materializes the owning Data Lake Object synchronously in the response
 * (`dataLakeObjectInfo`), confirmed against the real API -- no separate wait step is needed.
 *
 * **`IngestApi`-sourced streams need a schema registered on the connection before the stream
 * create call** -- confirmed live, with a real working payload. The real flow is:
 * 1. `PUT /ssot/connections/{connectionId}/schema` with `schemaType: "IngestApi"` and every field
 * the manifest declares in `dataLakeObjectInfo.dataLakeFieldInputRepresentations` -- this is
 * what actually defines the DLO's non-key fields live.
 * 2. `POST /ssot/data-streams`, with the create body's own
 * `dataLakeObjectInfo.dataLakeFieldInputRepresentations` trimmed to **only the primary key
 * field** -- confirmed live (sending every field there instead returns
 * `BAD_REQUEST: Illegal argument for data stream creation`; the real API materializes the rest
 * of the DLO's fields from the schema just upserted in step 1, not from this array). Also
 * needs `datastreamType: "INGEST_API"` (underscored -- not the `"INGESTAPI"` value documented
 * for the GET response's own `datastreamType` field) and
 * `connectorInfo.connectorDetails.events: [<schema name>]` naming the schema from step 1 --
 * omitting `events` is what previously produced a generic `INTERNAL_ERROR` with no further
 * detail. This adapter does both steps and the field-list trimming automatically for
 * `connectorType: "IngestApi"` -- a manifest just declares every real field once, the same
 * way every other connectorType's `dataLakeObjectInfo` already works.
 * This adapter requires `connectionId` as a manifest property (the connection's real numeric id,
 * e.g. `${Connection.x.id}`) -- it's not a real DataStream field, so it's stripped from the body
 * before either real request, the same way `DataModelObjectMapping.create()` reads `dataSpaceName`
 * for a query param rather than sending it in the body. `connectorInfo.connectorDetails.name`
 * (the connection's real, server-mangled `apiName`) is still required separately and is NOT
 * stripped -- it's a genuine field of the real request body.
 *
 * **The schema's `label` is validated as an identifier too, not as free text** -- confirmed live:
 * a schema upserted with the DLO's free-text label (e.g. `"Account DLO"`, with a space) fails with
 * `INVALID_API_INPUT: ... InvalidCharacterObjectName`. The DLO's real `name` is sent for both the
 * schema's `name` and `label` fields instead; the DLO's own display label
 * (`dataLakeObjectInfo.label`) is unaffected -- it's a separate field on the stream create body
 * that this doesn't touch.
 *
 * **Without a top-level `sourceFields: [{name, dataType}, ...]` in the create body, the real API
 * materializes every field -- including the declared primary key -- with `isPrimaryKey: false`**
 * -- confirmed live: a DLO created with only the schema-upsert (step 1) and the PK-trimmed
 * `dataLakeObjectInfo` (step 2) ends up with no primary key field at all on the real DLO, which
 * then fails `POST /ssot/data-model-object-mappings` with `Unable to find Primary Key of DLO in
 * POST request of Mapping Creation` for any mapping sourced from it. Adding `sourceFields` (one
 * entry per field, `dataType` -- not `datatype`, confirmed live: `datatype` is rejected with
 * `Unrecognized field "datatype"`) to the create body makes the real API set `isPrimaryKey`
 * correctly. This adapter adds it automatically alongside the PK-only trimming (`withPrimaryKeyOnly`).
 *
 * **The create/get response carries two distinct ids -- `id` and `recordId` -- and only `recordId`
 * is accepted by `GET`/`PATCH`/`DELETE /ssot/data-streams/{recordIdOrDeveloperName}`** -- confirmed
 * live: a stream created with `id: "1sdxx0000000001AAA"` and `recordId: "1dsxx0000000001AAA"` 404s
 * on `GET /ssot/data-streams/1sdxx0000000001AAA` with `ITEM_NOT_FOUND: DataStream found null for
 * developerName = 1sdxx0000000001AAA`, but succeeds on `GET /ssot/data-streams/1dsxx0000000001AAA`
 * (same confirmed for `PATCH` and `DELETE`). This adapter's `toReadResult` returns `recordId` (not
 * `id`) as the tracked `id` -- every other adapter in this codebase can assume the create
 * response's `id` field is what `read`/`update`/`delete` accept; this is the one exception.
 *
 * **A DLO with `category: "Engagement"` requires `dataLakeObjectInfo.eventDateTimeFieldName`** --
 * confirmed live: creating an `Engagement`-category DLO without it fails with
 * `BAD_REQUEST: Illegal argument for data stream creation`, even though the field isn't called
 * out in the create-request schema docs (which list `recordModifiedFieldName` as a sibling
 * property used by other categories, e.g. SFDC-sourced streams) -- the response's own `fields`
 * examples for `category: "Engagement"` show `eventDateTimeFieldName` instead. It must name a
 * real field already declared in `dataLakeFieldInputRepresentations` (here, in the schema
 * upserted in step 1, since the create body only carries the primary key field -- see below).
 * `category: "Other"` (and the other categories) have no such requirement. This adapter does not
 * enforce or default this -- a manifest using `category: "Engagement"` must set
 * `eventDateTimeFieldName` itself.
 *
 * **The real API mangles both the stream's and the DLO's submitted `name` on create** -- the
 * server combines the connection's label with the stream/DLO's own label into a generated
 * identifier (e.g. a DLO submitted as `"example_dlo"` on a `"Example Connection"` connection came
 * back as `"Example_Connection_ExampleDLO_ABC12345__dll"`). Since downstream resources (e.g.
 * `DataModelObjectMapping`) need the DLO's real name to reference it, this adapter surfaces it
 * as a `dlApiName` output (the embedded `dataLakeObjectInfo.name` from the real response),
 * referenceable as `${DataStream.x.dlApiName}`.
 */
export class DataStreamAdapter extends RestAdapterBase {
  public readonly setLikePaths = [
    'sourceFields',
    'dataLakeObjectInfo.dataLakeFieldInputRepresentations',
    'dataLakeObjectInfo.dataspaceInfo',
  ];
  public constructor() {
    super({
      type: 'DataStream',
      resourcePlural: 'data-streams',
      listResponseKey: 'dataStreams',
      fieldClassification: {
        name: 'replace',
        connectionId: 'replace',
        datasource: 'replace',
        datastreamType: 'replace',
        connectorInfo: 'replace',
        dataLakeObjectInfo: 'replace',
        sourceFields: 'update',
        mappings: 'update',
        refreshConfig: 'update',
        advancedAttributes: 'update',
        label: 'update',
      },
      buildLookupQuery: (key) => ({ connectionName: key.connectionName as string | undefined }),
      toReadResult: (item): AdapterReadResult => {
        const { id, recordId, ...properties } = item;
        const name = item.name as string | number | undefined;
        const dlApiName = (item.dataLakeObjectInfo as Record<string, unknown> | undefined)?.name as string | undefined;
        return {
          // `recordId` -- not `id` -- is what GET/PATCH/DELETE /ssot/data-streams/{recordIdOrDeveloperName}
          // actually accept; see the class doc comment. Falls back to `id` defensively, in case some
          // response shape omits `recordId`.
          id: String(recordId ?? id),
          apiName: name !== undefined ? String(name) : undefined,
          properties: { ...properties, dlApiName },
        };
      },
    });
  }

  /**
   * Registers every field the manifest declares for the DLO (not just the primary key) as an
   * `IngestApi` schema on the connection, named after the DLO itself.
   */
  private static async upsertIngestApiSchema(
    ctx: AdapterContext,
    connectionId: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const dlo = body.dataLakeObjectInfo as Record<string, unknown>;
    const fields = (dlo.dataLakeFieldInputRepresentations as FieldInput[]).map((f) => ({
      name: f.name,
      label: f.label ?? f.name,
      dataType: f.dataType,
    }));

    await ctx.client.request({
      method: 'PUT',
      path: `${memberPath('connections', connectionId)}/schema`,
      body: {
        schemas: [
          {
            name: dlo.name,
            // The real endpoint validates `label` the same way as `name` -- a free-text label
            // with spaces (e.g. "Account DLO") is rejected with `InvalidCharacterObjectName`,
            // confirmed live. Send the DLO's real `name` for both; the DLO's own display label
            // (`dataLakeObjectInfo.label`) is untouched and set separately on the stream itself.
            label: dlo.name,
            schemaType: 'IngestApi',
            fields,
          },
        ],
      },
    });
  }

  private static matchesCreatedStream(
    item: Record<string, unknown>,
    properties: Record<string, unknown>,
    completeScopedInventory: boolean
  ): boolean {
    const desiredConnector = properties.connectorInfo as Record<string, unknown>;
    const desiredDetails = desiredConnector.connectorDetails as Record<string, unknown>;
    const connector = item.connectorInfo as Record<string, unknown> | undefined;
    const details = connector?.connectorDetails as Record<string, unknown> | undefined;
    if (connector?.connectorType !== desiredConnector.connectorType || (item.recordId ?? item.id) === undefined)
      return false;
    if (details?.name !== undefined && details.name !== desiredDetails.name) return false;
    if (item.label === properties.label && details?.name === desiredDetails.name) return true;
    // Verified IngestApi list responses can omit connectorDetails and generate a new label.
    // In that shape, require a complete connection-filtered inventory and the full DLO schema.
    if (desiredConnector.connectorType !== 'IngestApi' || !completeScopedInventory) return false;
    return DataStreamAdapter.matchesIngestApiConfiguration(item, properties);
  }

  private static matchesIngestApiConfiguration(
    item: Record<string, unknown>,
    properties: Record<string, unknown>
  ): boolean {
    const desired = properties.dataLakeObjectInfo as Record<string, unknown> | undefined;
    const live = item.dataLakeObjectInfo as Record<string, unknown> | undefined;
    if (!desired || !live || live.label !== desired.label || live.category !== desired.category) return false;
    if (live.name !== `${String(item.name)}__dll`) return false;
    if ((item.dataStreamType ?? item.datastreamType) !== 'INGESTAPI' && item.datastreamType !== 'INGEST_API')
      return false;
    const spaces = (live.dataSpaceInfo ?? live.dataspaceInfo) as Array<{ name: string }> | undefined;
    const desiredSpaces = desired.dataspaceInfo as Array<{ name: string }> | undefined;
    if (!Array.isArray(spaces) || !Array.isArray(desiredSpaces)) return false;
    if (
      spaces
        .map((space) => space.name)
        .sort()
        .join('|') !==
      desiredSpaces
        .map((space) => space.name)
        .sort()
        .join('|')
    )
      return false;
    const fields = desired.dataLakeFieldInputRepresentations as FieldInput[] | undefined;
    const sourceFields = item.sourceFields as Array<{ name: string; datatype?: string; dataType?: string }> | undefined;
    const liveFields = live.dataLakeFieldInfoRepresentation as FieldInput[] | undefined;
    if (!Array.isArray(fields) || !Array.isArray(sourceFields) || !Array.isArray(liveFields)) return false;
    if (fields.length !== sourceFields.length || new Set(sourceFields.map((f) => f.name)).size !== fields.length)
      return false;
    if (
      !fields.every((field) =>
        sourceFields.some(
          (liveField) => liveField.name === field.name && (liveField.datatype ?? liveField.dataType) === field.dataType
        )
      )
    )
      return false;
    const expectedKeys = fields
      .filter((f) => f.isPrimaryKey)
      .map((f) => f.name)
      .sort();
    const actualKeys = liveFields
      .filter((f) => f.isPrimaryKey)
      .map((f) => f.name)
      .sort();
    return expectedKeys.length > 0 && JSON.stringify(expectedKeys) === JSON.stringify(actualKeys);
  }

  /**
   * The stream create call itself only accepts the primary key field in
   * `dataLakeObjectInfo.dataLakeFieldInputRepresentations` -- every other field comes from the
   * schema already upserted onto the connection. Returns a new object; never mutates `body` (or
   * its nested `dataLakeObjectInfo`), which may still be referenced elsewhere.
   *
   * Also adds a top-level `sourceFields: [{name, dataType}, ...]` listing every field -- without
   * it, the real API materializes every field (including the declared primary key) with
   * `isPrimaryKey: false`, confirmed live: a DLO created without `sourceFields` has no primary
   * key field at all, which later fails `POST /ssot/data-model-object-mappings` with `Unable to
   * find Primary Key of DLO in POST request of Mapping Creation`. Including `sourceFields`
   * (confirmed live, by trial: `datatype` -- the GET response's own field name -- is rejected
   * with `Unrecognized field "datatype"`; the create body needs `dataType`, matching
   * `dataLakeFieldInputRepresentations`) makes the real API set `isPrimaryKey` correctly on the
   * materialized DLO instead.
   */
  private static withPrimaryKeyOnly(body: Record<string, unknown>): Record<string, unknown> {
    const dlo = body.dataLakeObjectInfo as Record<string, unknown>;
    const fields = dlo.dataLakeFieldInputRepresentations as FieldInput[];
    return {
      ...body,
      sourceFields: fields.map((f) => ({ name: f.name, dataType: f.dataType })),
      dataLakeObjectInfo: {
        ...dlo,
        dataLakeFieldInputRepresentations: fields.filter((f) => f.isPrimaryKey),
      },
    };
  }

  public async create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    const connectorInfo = properties.connectorInfo as Record<string, unknown> | undefined;
    const isIngestApi = connectorInfo?.connectorType === 'IngestApi';

    const { connectionId, ...rest } = properties;
    let body = rest;
    if (isIngestApi) {
      await DataStreamAdapter.upsertIngestApiSchema(ctx, String(connectionId), body);
      body = DataStreamAdapter.withPrimaryKeyOnly(body);
    }

    try {
      const item = await ctx.client.request<Record<string, unknown>>({
        method: 'POST',
        path: collectionPath(this.resourcePlural),
        body,
      });
      return item ? this.toReadResult(item) : undefined;
    } catch (error) {
      if (ctx.journaled) throw error;
      // A lost response can leave a live stream absent from local state. The duplicate error
      // also covers resuming an apply after an earlier timeout. Never resend the create here.
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryableConnectRestError(error) && !/EDTO .*already in use/i.test(message)) throw error;
      try {
        const existing = await this.findCreatedStream(ctx, properties);
        if (existing) return existing;
      } catch {
        // A failed reconciliation must preserve the original create error.
      }
      throw error;
    }
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    // Defaults to also deleting the materialized DLO, matching the lifecycle this manifest
    // schema implies (a DataStream block owns its embedded dataLakeObjectInfo).
    await ctx.client.request({
      method: 'DELETE',
      path: withQuery(memberPath(this.resourcePlural, id), { shouldDeleteDataLakeObject: true }),
    });
  }

  private async findCreatedStream(
    ctx: AdapterContext,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    const connector = properties.connectorInfo as Record<string, unknown> | undefined;
    const details = connector?.connectorDetails as Record<string, unknown> | undefined;
    // Names are rewritten by Salesforce. Use the display label plus the resolved connection
    // and connector type; a label alone could belong to another connection.
    if (typeof properties.label !== 'string' || typeof details?.name !== 'string' || !connector?.connectorType) {
      return undefined;
    }
    const items: Array<Record<string, unknown>> = [];
    const visited = new Set<string>();
    let totalSize: number | undefined;
    let path: string | undefined = withQuery(collectionPath(this.resourcePlural), { connectionName: details.name });
    while (path && !visited.has(path)) {
      visited.add(path);
      // eslint-disable-next-line no-await-in-loop -- follow verified pagination sequentially.
      const response: Record<string, unknown> = await ctx.client.request({ method: 'GET', path });
      if (!Array.isArray(response.dataStreams)) return undefined;
      items.push(...(response.dataStreams as Array<Record<string, unknown>>));
      if (typeof response.totalSize === 'number') {
        if (totalSize !== undefined && totalSize !== response.totalSize) return undefined;
        totalSize = response.totalSize;
      }
      path = typeof response.nextPageUrl === 'string' ? response.nextPageUrl : undefined;
    }
    if (path || (totalSize !== undefined && items.length !== totalSize)) return undefined;
    const completeScopedInventory = totalSize !== undefined && items.length === totalSize;
    const matches = items.filter((item) =>
      DataStreamAdapter.matchesCreatedStream(item, properties, completeScopedInventory)
    );
    return matches.length === 1 ? this.toReadResult(matches[0]) : undefined;
  }
}
