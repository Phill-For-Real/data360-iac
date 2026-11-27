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
import { collectionPath } from './real-paths.js';
import { pollUntilStatus } from './status-poll.js';

/**
 * `apiName` is the real lookup key (server-suffixes it `__cio`, e.g. a manifest's
 * `apiName: "VehicleHealthScore"` create becomes the live `"VehicleHealthScore__cio"`) --
 * `lookup()` accounts for this: a manifest-declared `apiName` matches a live item whose own
 * `apiName` is either the exact value or that value plus `__cio`, confirmed live (an exact-only
 * comparison never adopts an already-live insight, since the server's `apiName` always carries
 * the suffix while the manifest's never does). The real expression syntax is genuinely SQL
 * (`SELECT ... FROM ... JOIN ... GROUP BY ...`), passed through untouched -- no DSL validation
 * needed. The list response is unusually wrapped in a `collection` envelope
 * (`{collection: {items: [...]}}`), unlike every other resource type, so lookup() is overridden.
 *
 * `publishScheduleInterval` is sent in canonical case (e.g. `"Six"`) but the server echoes it
 * back uppercased (`"SIX"`) -- confirmed against the official API reference. Left as-is, this
 * would make `PlanEngine`'s exact-string diff see a perpetual spurious change on every `plan`
 * after a successful `apply`; `toReadResult` normalizes it back to the canonical casing read-side
 * so a live read always matches what a manifest would send.
 *
 * **`PATCH` rejects `apiName`/`definitionType`/`dataSpaceName` in the body, even when the value is
 * unchanged** -- confirmed live: `Cannot change the calculated insight definition type.`, hit via
 * `adopt-update` (an already-live insight adopted into state, where its properties otherwise
 * differ enough from the manifest to not be a clean adopt) sending every manifest property
 * including these three `'replace'`-classified, create-only fields. `update()` strips them before
 * the real request; `create()` still sends all three, since they're genuinely required there.
 *
 * TODO(API-SPEC): exact terminal/failure `calculatedInsightStatus` values beyond "PROCESSING"
 * are a best-effort guess -- see API_NOTES.md.
 */
const PUBLISH_SCHEDULE_INTERVAL_CANONICAL: Record<string, string> = {
  EXTERNALLYMANAGED: 'ExternallyManaged',
  NOTSCHEDULED: 'NotScheduled',
  ONE: 'One',
  SIX: 'Six',
  STREAMING: 'Streaming',
  SYSTEMMANAGED: 'SystemManaged',
  TWELVE: 'Twelve',
  TWENTYFOUR: 'TwentyFour',
};

function normalizePublishScheduleInterval(item: Record<string, unknown>): Record<string, unknown> {
  const value = item.publishScheduleInterval;
  if (typeof value !== 'string') return item;
  const canonical = PUBLISH_SCHEDULE_INTERVAL_CANONICAL[value.toUpperCase()];
  return canonical ? { ...item, publishScheduleInterval: canonical } : item;
}

const HTML_ENTITY_UNESCAPE: Record<string, string> = {
  '&#39;': "'",
  '&quot;': '"',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
};

/**
 * The real API HTML-escapes the stored `expression` (confirmed live: a manifest's literal `'`
 * inside a `WHERE`/`CASE` clause comes back as `&#39;`) -- left as-is, this would make
 * `PlanEngine`'s exact-string diff see a perpetual spurious `update` on every `plan` after a
 * successful `apply` (the same failure mode `publishScheduleInterval` has, just a different
 * field), forcing an `adopt-update` through this resource's full create/run/wait cycle every
 * single time instead of a clean, no-op adopt.
 */
function unescapeExpression(item: Record<string, unknown>): Record<string, unknown> {
  const value = item.expression;
  if (typeof value !== 'string') return item;
  const unescaped = value.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (entity) => HTML_ENTITY_UNESCAPE[entity]);
  return unescaped === value ? item : { ...item, expression: unescaped };
}

function matchesApiName(itemApiName: unknown, lookupApiName: unknown): boolean {
  if (typeof itemApiName !== 'string' || typeof lookupApiName !== 'string') return false;
  return itemApiName === lookupApiName || itemApiName === `${lookupApiName}__cio`;
}

/**
 * `properties.apiName` is normalized back to the manifest's unsuffixed form (the top-level
 * `apiName`/`id` output used for `${CalculatedInsight.x.apiName}` references keeps the real,
 * server-suffixed value, unaffected) -- without this, `PlanEngine`'s exact-string diff compares
 * the manifest's `"VehicleHealthScore"` against the live `"VehicleHealthScore__cio"` and always
 * sees a change (the same failure mode as `expression`/`publishScheduleInterval` above), forcing
 * `adopt-update` -- and its full create/run/wait cycle -- on every single `plan`/`apply`, never a
 * clean, no-op adopt.
 */
function stripApiNameSuffix(item: Record<string, unknown>): Record<string, unknown> {
  const value = item.apiName;
  if (typeof value !== 'string' || !value.endsWith('__cio')) return item;
  return { ...item, apiName: value.slice(0, -'__cio'.length) };
}

/**
 * The real read response names this field `dataSpace`, not `dataSpaceName` -- confirmed live.
 * Left alone, this isn't a value mismatch but a **field-name** mismatch: `diffFields` sees the
 * manifest's `dataSpaceName` as removed (desired-only) and the live `dataSpace` as added
 * (live-only) -- two spurious changed fields instead of zero, on every single `plan`. `read()`
 * renames it back to `dataSpaceName` to match what the manifest (and `create()`'s request body)
 * actually uses.
 */
function renameDataSpaceField(item: Record<string, unknown>): Record<string, unknown> {
  if (!('dataSpace' in item)) return item;
  const { dataSpace, ...rest } = item;
  return { ...rest, dataSpaceName: dataSpace };
}

export class CalculatedInsightAdapter extends RestAdapterBase implements AsyncJobAdapter {
  public constructor() {
    super({
      type: 'CalculatedInsight',
      resourcePlural: 'calculated-insights',
      listResponseKey: 'items',
      fieldClassification: {
        apiName: 'replace',
        definitionType: 'replace',
        dataSpaceName: 'replace',
        expression: 'update',
        description: 'update',
        displayName: 'update',
        publishScheduleInterval: 'update',
        publishScheduleStartDateTime: 'update',
      },
      matchesLookupKey: (item, key) => matchesApiName(item.apiName, key.apiName),
      toReadResult: (item): AdapterReadResult => {
        const realApiName = String(item.apiName);
        const normalized = normalizeCalculatedInsight(item);
        return { id: realApiName, apiName: realApiName, properties: normalized };
      },
    });
  }

  public async lookup(ctx: AdapterContext, lookupKey: Record<string, unknown>): Promise<AdapterReadResult> {
    const response = await ctx.client.request<{ collection?: { items?: Array<Record<string, unknown>> } } | null>({
      method: 'GET',
      path: collectionPath(this.resourcePlural),
    });
    const items = response?.collection?.items ?? [];
    const matches = items.filter((item) => matchesApiName(item.apiName, lookupKey.apiName));
    if (matches.length > 1) throw new Error('Ambiguous CalculatedInsight lookup');
    const match = matches[0];
    return match ? this.toReadResult(match) : undefined;
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    // apiName/definitionType/dataSpaceName are create-only -- the real PATCH rejects them even
    // when unchanged. See the class doc comment.
    const rest = { ...properties };
    delete rest.apiName;
    delete rest.definitionType;
    delete rest.dataSpaceName;
    return super.update(ctx, id, rest);
  }

  public async waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>> {
    // The real create/update already kicks off processing on its own -- confirmed live: a PATCH
    // alone (with no explicit actions/run) transitioned calculatedInsightStatus
    // ACTIVE -> PROCESSING -> ACTIVE again within a few seconds, with no actions/run call at all.
    // Calling actions/run explicitly is therefore both unnecessary and, confirmed live, a call
    // that can hang/time out against this org's calculated-insights endpoint (observed failing
    // both retry attempts against an insight that was, at that very moment, independently
    // confirmed ACTIVE via a direct GET) -- turning a true no-op into a hard apply failure for
    // no behavioral benefit. If the insight is already ACTIVE when this runs, return
    // immediately rather than polling for a transition that will never happen.
    const current = await this.read(ctx, id);
    const currentStatus = current?.properties.calculatedInsightStatus as string | undefined;
    if (currentStatus === 'ACTIVE') {
      return current?.properties ?? {};
    }

    return pollUntilStatus({
      read: () => this.read(ctx, id),
      statusOf: (result) => result?.properties.calculatedInsightStatus as string | undefined,
      terminalValues: ['ACTIVE'],
      failureValues: ['ERROR'],
      onPoll: ctx.onJobPoll,
    });
  }
}

/** Normalises a raw GET exactly once. Keep suffixed identifiers outside comparable properties. */
export function normalizeCalculatedInsight(item: Record<string, unknown>): Record<string, unknown> {
  return renameDataSpaceField(stripApiNameSuffix(unescapeExpression(normalizePublishScheduleInterval(item))));
}
