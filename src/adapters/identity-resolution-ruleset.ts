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
import { AdapterContext, AdapterReadResult, AsyncJobAdapter, DeletionObservation } from './types.js';
import { actionPath } from './real-paths.js';
import { postAction, pollUntilStatus } from './status-poll.js';

/**
 * There are two independent status fields on this resource, the same split as
 * `CalculatedInsight`'s `calculatedInsightStatus` (metadata/definition) vs. `lastRunStatus` (the
 * data refresh): `rulesetStatus` (the ruleset *definition* -- `"NEW"` -> async `"PUBLISHING"` ->
 * `"PUBLISHED"`) and `lastJobStatus` (the match/reconciliation *job*, which can stay
 * `"IN_PROGRESS"` for a long time against a large source population and is unrelated to whether
 * the ruleset itself is correctly defined and live). Per explicit product guidance: this
 * resource is considered applied once `rulesetStatus` reaches `"PUBLISHED"` -- a still-running
 * match job never blocks the rest of `apply`, the same way `CalculatedInsight` doesn't wait for
 * `lastRunStatus` either.
 *
 * `actions/run-now` is still triggered once published (to kick off the match job so its results
 * do eventually appear), but its own completion is never awaited here -- only the `resultCode`
 * response from firing it.
 *
 * **A freshly created ruleset isn't immediately runnable** -- confirmed live and in the Redoc
 * spec: calling `actions/run-now` before `rulesetStatus` reaches `"PUBLISHED"` fails with
 * `We couldn't run the ruleset job. Try again when the ruleset's status is Published.`. This
 * adapter polls for `rulesetStatus: "PUBLISHED"` first, using the same poll-by-re-GET pattern
 * used everywhere else in this plugin (no dedicated wait endpoint exists).
 *
 * **This resource has no `apiName`/`name` manifest property, only `label`** -- `lookup()`
 * matches on it (same pattern as `ConnectionAdapter`). Without this, a ruleset already live from
 * a prior `apply` whose `create()` call timed out client-side but actually succeeded
 * server-side (confirmed live: `apply` reported a timeout while the real API had already
 * created and published the ruleset) could never be adopted on a later `plan`/`apply` -- it
 * would keep trying to create a duplicate and fail with `Ruleset ID '' is already in use`.
 *
 * **`PATCH` rejects `configurationType` and `rulesetId` entirely, even unchanged** -- confirmed
 * live: `Unrecognized field "configurationType"`, then (once that was also stripped)
 * `Unrecognized field "rulesetId"` -- both hit via `adopt-update` sending every manifest
 * property, including these create-only fields (same pattern as `CalculatedInsight`'s
 * `apiName`/`definitionType`/`dataSpaceName`). `update()` strips both before the real request.
 */
export class IdentityResolutionRulesetAdapter extends RestAdapterBase implements AsyncJobAdapter {
  public constructor() {
    super({
      type: 'IdentityResolutionRuleset',
      resourcePlural: 'identity-resolutions',
      listResponseKey: 'identityResolutions',
      fieldClassification: {
        configurationType: 'replace',
        matchRules: 'update',
        reconciliationRules: 'update',
        doesRunAutomatically: 'update',
        label: 'update',
        description: 'update',
      },
      matchesLookupKey: (item, key) => typeof key.label === 'string' && item.label === key.label,
    });
  }

  public async observeDeletion(ctx: AdapterContext, id: string): Promise<DeletionObservation> {
    try {
      const live = await this.read(ctx, id);
      if (!live) return { outcome: 'unknown' };
      const status = live.properties.rulesetStatus;
      if (typeof status !== 'string') return { outcome: 'present' };
      // A deleting status is progress evidence only, never proof of absence.
      return { outcome: status.toUpperCase().includes('DELET') ? 'deleting' : 'present', status };
    } catch (error) {
      const response = error as {
        statusCode?: number;
        status?: number;
        name?: string;
        errorCode?: string;
        message?: string;
      };
      const status = response?.statusCode ?? response?.status;
      if (status === 404) return { outcome: 'absent' };
      if (status !== undefined) return { outcome: 'unknown' };
      // Verified SDK behaviour: this member GET's ITEM_NOT_FOUND error omits HTTP status.
      // Match both the provider code and the exact recorded identity, not arbitrary not-found errors.
      const code = response?.errorCode ?? response?.name;
      return code === 'ITEM_NOT_FOUND' && response.message?.trim() === `Identity Resolution not found: ${id}`
        ? { outcome: 'absent' }
        : { outcome: 'unknown' };
    }
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    // configurationType/rulesetId are create-only -- the real PATCH rejects both even
    // unchanged. See the class doc comment.
    const rest = { ...properties };
    delete rest.configurationType;
    delete rest.rulesetId;
    return super.update(ctx, id, rest);
  }

  public async waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>> {
    const published = await pollUntilStatus({
      read: () => this.read(ctx, id),
      statusOf: (result) => result?.properties.rulesetStatus as string | undefined,
      terminalValues: ['PUBLISHED'],
      failureValues: ['FAILED', 'ERROR'],
      onPoll: ctx.onJobPoll,
    });

    // Fire the match job but don't wait for it -- rulesetStatus: "PUBLISHED" is this resource's
    // own completion signal (see class doc comment); a long-running job against a large source
    // population must never block the rest of apply.
    await postAction(ctx, actionPath(this.resourcePlural, id, 'run-now'), { callingApp: 'Flow' });
    return published;
  }
}
