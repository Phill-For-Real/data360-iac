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
import { isRejectedDependencyDelete } from '../retry/deletion-contract.js';
import { retryWithBackoff } from '../retry/backoff.js';
import { RestAdapterBase } from './rest-adapter-base.js';
import { AdapterContext, AdapterReadResult } from './types.js';
import { collectionPath, memberPath } from './real-paths.js';

/**
 * `POST /ssot/connections` returns an empty body (201, no id) -- the real API does not echo
 * back the created resource. This adapter follows up with a lookup to find the id.
 *
 * **The real API silently rewrites the submitted `name` on create** -- confirmed live: a manifest
 * declaring `"name": "core_crm_connection"` comes back as something like
 * `"Core_CRM_ff6ceb44_0a0d_4068_a8f5_85f4c27112a2"` (the label, lowercased-and-underscored, plus a
 * random UUID suffix). `label` is preserved exactly as submitted. A `devName`-filtered lookup
 * (matching on the real, unpredictable `name`) can therefore never find a connection this adapter
 * just created, or one declared by a manifest that hasn't been applied yet -- the lookup/adoption
 * key is `label`, not `devName`, for this reason.
 *
 * `GET /ssot/connections` requires `connectorType` as a query param -- it's not an optional
 * filter alongside `label`, the real API rejects the list call entirely without it
 * (`ILLEGAL_QUERY_PARAMETER_VALUE: ConnectorType must be provided`, confirmed live).
 *
 * `connectorType` is a real discriminator selecting one of five distinct create/replace request
 * schemas, confirmed against the official Connect REST API reference (Redoc). Beyond the
 * universal `connectorType`/`name`/`label`:
 * - `IngestApi` ("Ingest API Connection Input"): no extra fields.
 * - `SalesforceDotCom` ("CRM Connection Input"): `organizationId` (**required** -- the 15/18-char
 * Salesforce org id of the connected CRM org; confirmed live via
 * `organizationId is required. Provide the 15 or 18 character ID of the Data Cloud Home Org.`).
 * - `SalesforceMarketingCloud` ("Marketing Cloud Connection Input"): no extra fields on create.
 * - `StreamingApp` ("Streaming App Connection Input"): `streamingAppType` (**required**, enum
 * `MobileApp`/`ServerApp`/`WebApp`), `streamingAppSubType` (optional).
 * - every other connectorType, e.g. `AwsS3`/`AwsRdsPostgres`/`AzureBlob`/`Databricks`/`Gcs`/
 * `Sftp` ("Data Connection Input"): `credentials` and `parameters` (both **required**, shaped
 * `{ attributes: [{ name, value }] }`), `method` (**required**, enum `Egress`/`Ingress`).
 *
 * This adapter doesn't validate which fields a given `connectorType` requires or forbids --
 * consistent with this plugin's "pass properties through, let the real API validate" design --
 * `fieldClassification` below just covers the union of every real field across all five schemas.
 *
 * `PATCH /ssot/connections/{id}` (update) is narrower than create: the real API only supports
 * updating `SalesforceMarketingCloud` or `StreamingApp` connections (via distinct Patch schemas:
 * `addActivationBusinessUnits`/`addIngestionBusinessUnits`/etc. for Marketing Cloud, `modules`
 * for Streaming App) -- updating a `SalesforceDotCom`/`AwsS3`/etc. connection's fields via PATCH
 * is not supported at all and will fail live. Not enforced here for the same reason as above.
 *
 * **Deleting a `DataStream` that still owns this connection doesn't synchronously release it** --
 * confirmed live: destroying a `DataStream` reports success while the real stream is still
 * `status: "DELETING"` for up to ~30s afterward; deleting the connection in that window fails
 * with `DEPENDENCY_EXISTS` (`BAD_REQUEST`, no further detail), and retrying the exact same delete
 * once the stream finishes tearing down succeeds with no other change. `delete()` retries
 * specifically on `DEPENDENCY_EXISTS` (a real conflict from an actual, unrelated live dependency
 * still fails immediately).
 */
export class ConnectionAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'Connection',
      resourcePlural: 'connections',
      listResponseKey: 'connections',
      fieldClassification: {
        connectorType: 'replace',
        name: 'replace',
        organizationId: 'replace',
        streamingAppType: 'replace',
        method: 'replace',
        label: 'update',
        streamingAppSubType: 'update',
        credentials: 'update',
        parameters: 'update',
      },
      buildLookupQuery: (key) => ({
        connectorType: key.connectorType as string | undefined,
        label: key.label as string | undefined,
      }),
      matchesLookupKey: (item, key) => item.label === key.label,
    });
  }

  public async create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    await ctx.client.request({ method: 'POST', path: collectionPath(this.resourcePlural), body: properties });

    const label = String(properties.label);
    const found = await this.lookup(ctx, { label, connectorType: properties.connectorType });
    if (!found) {
      throw new Error(`Connection with label "${label}" was created but could not be found afterward via label lookup`);
    }
    return found;
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    await retryWithBackoff(
      () =>
        ctx.client.request({
          method: 'DELETE',
          path: memberPath(this.resourcePlural, id),
          replayContract: 'rejected-dependency-delete',
        }),
      { initialDelayMs: 5_000, maxDelayMs: 15_000, factor: 2, maxAttempts: 5 },
      isRejectedDependencyDelete
    );
  }
}
