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
import { AdapterContext, AdapterReadResult, AsyncJobAdapter } from './types.js';
import { memberPath } from './real-paths.js';
import { pollUntilStatus } from './status-poll.js';

/**
 * Dual identifier: the real create/update/delete/get paths key by `apiName`, but the publish
 * action keys by the numeric `marketSegmentId`. This adapter's `id` is always the numeric
 * `marketSegmentId` (needed for `waitForCompletion`); `update()`/`delete()` first re-GET the
 * segment (which accepts either id or apiName) to resolve its current `apiName`, then call the
 * apiName-keyed endpoint.
 *
 * `developerName` is required on create and confirmed NOT supported on update (the real PATCH
 * schema omits it) -- classified `'replace'`.
 *
 * **`GET /ssot/segments/{id}` wraps its single result in `{ segments: [...] }`, unlike the
 * create/update responses (bare) and unlike every other resource type's member-GET** --
 * confirmed live. `toReadResult` unwraps this; left unhandled, a re-`GET` (every
 * `waitForCompletion` poll, and the `update()`/`delete()` re-read that resolves the current
 * `apiName`) silently builds its `AdapterReadResult` from the wrapper object itself --
 * `segmentStatus` is always `undefined`, so a job polling for `segmentStatus: "ACTIVE"` never
 * reaches a terminal state and hangs until the overall polling timeout.
 *
 * **`segmentType: "UI"` is rejected for API/external callers** -- confirmed live:
 * `EXTERNAL_RESOURCE_FORBIDDEN: UI based segment creation is forbidden for external users.`.
 * `Waterfall` is the type real API-driven manifests should use instead; `Standard`/`Rule`/
 * `Calculated`/`API` were tried and rejected outright (`Invalid value for Segment Type`), so
 * `Waterfall` may be the only API-creatable type in this org. See API_NOTES.md.
 *
 * **`publishScheduleInfo.interval` only accepts specific hour values, and only some of them
 * work for standard publish** -- confirmed live: `1` always fails with the opaque
 * `endTime details absent for segments or it should be non expiring.` regardless of every other
 * field; `6` fails with `Incorrect interval for standard publish.`; `12` and `24` both succeed.
 * `daysOfWeek` must also be non-empty for `frequency: "Daily"` (empty triggers the same opaque
 * "endTime" error) -- all seven days express a true daily cadence.
 *
 * TODO(API-SPEC): exact terminal/failure `segmentStatus` values beyond "PROCESSING" are a
 * best-effort guess -- see API_NOTES.md. Newer API versions also require `dataspace` as a
 * query param on create/update rather than a body field -- not supported by this adapter yet
 * (affects only non-default-data-space orgs); see API_NOTES.md.
 */
export class SegmentAdapter extends RestAdapterBase implements AsyncJobAdapter {
  public constructor() {
    super({
      type: 'Segment',
      resourcePlural: 'segments',
      listResponseKey: 'segments',
      fieldClassification: {
        segmentOnApiName: 'replace',
        segmentType: 'replace',
        developerName: 'replace',
        displayName: 'update',
        description: 'update',
        publishScheduleInfo: 'update',
        publishScheduleStartDateTime: 'update',
        publishScheduleEndDateTime: 'update',
      },
      toReadResult: (item): AdapterReadResult => {
        // GET /ssot/segments/{id} wraps its single result in { segments: [...] } -- confirmed
        // live, unlike every other resource type's member-GET (and unlike this same resource's
        // own create/update responses, which are bare). Left unhandled, `read()` builds an
        // AdapterReadResult from the wrapper object itself: id becomes the string "undefined"
        // (item.marketSegmentId doesn't exist on the wrapper) and properties.segmentStatus is
        // always undefined -- which silently breaks every `waitForCompletion` poll (never
        // reaches a terminal status) and any `update()`/`delete()` call that first re-reads the
        // segment to resolve its apiName.
        const segments = item.segments;
        const unwrapped = (Array.isArray(segments) ? (segments[0] as Record<string, unknown>) : item) ?? item;
        return {
          id: String(unwrapped.marketSegmentId),
          apiName: String(unwrapped.apiName),
          properties: unwrapped,
        };
      },
    });
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    const current = await this.read(ctx, id);
    if (!current?.apiName) {
      throw new Error(`Cannot update Segment "${id}": apiName could not be resolved`);
    }
    const response = await ctx.client.request<Record<string, unknown>>({
      method: 'PATCH',
      path: memberPath(this.resourcePlural, current.apiName),
      body: properties,
    });
    return { id: String(response.marketSegmentId), apiName: String(response.apiName), properties: response };
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    const current = await this.read(ctx, id);
    if (!current?.apiName) {
      throw new Error(`Cannot delete Segment "${id}": apiName could not be resolved`);
    }
    await ctx.client.request({ method: 'DELETE', path: memberPath(this.resourcePlural, current.apiName) });
  }

  public async waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>> {
    // create/update already kick off qualification on their own -- confirmed live: a freshly
    // created segment transitions PROCESSING -> ACTIVE with no actions/publish call at all.
    // Calling actions/publish on a segment that's already ACTIVE fails live with an opaque
    // INTERNAL_ERROR ("We couldn't publish your segment...") -- same pattern as
    // CalculatedInsight's actions/run. If already ACTIVE, return immediately rather than firing
    // a redundant, failing publish call.
    const current = await this.read(ctx, id);
    const currentStatus = current?.properties.segmentStatus as string | undefined;
    if (currentStatus === 'ACTIVE') {
      return current?.properties ?? {};
    }

    return pollUntilStatus({
      read: () => this.read(ctx, id),
      statusOf: (result) => result?.properties.segmentStatus as string | undefined,
      terminalValues: ['ACTIVE'],
      failureValues: ['ERROR', 'FAILED'],
      onPoll: ctx.onJobPoll,
    });
  }
}
