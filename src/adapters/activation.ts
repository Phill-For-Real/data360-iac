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
import { AdapterContext, AsyncJobAdapter, AdapterReadResult } from './types.js';
import { safePutProperties } from './configuration.js';
import { pollUntilStatus } from './status-poll.js';

/**
 * The real update endpoint is PUT, not PATCH. The real create body is a large structured config
 * (`attributesConfig`, `contactPointsConfig`, `directDmoFiltersConfig`, `relatedDmoFiltersConfig`)
 * with no resemblance to a simple segment-to-target mapping -- passed through untouched.
 *
 * The full-refresh action's real path would be `POST /ssot/activations/actions/{id}/full-refresh`
 * -- structurally different from every other resource's `{id}/actions/{verb}` pattern (the id
 * comes *after* `actions`, not before), confirmed against the official API reference -- but this
 * adapter never actually calls it (see `waitForCompletion`'s doc comment for why).
 *
 * **`create` alone drives the Activation to `status: "ACTIVE"` on its own, typically within
 * seconds -- `actions/full-refresh` is never called at all** -- confirmed live, same pattern as
 * `CalculatedInsight`/`Segment`, but even more clear-cut here: a direct timing race was
 * observed where a freshly created activation was still `PROCESSING` at the moment of
 * `waitForCompletion`'s own pre-check read, then settled to `ACTIVE` on its own well before an
 * explicit `actions/full-refresh` call (fired because the pre-check hadn't yet seen `ACTIVE`)
 * finished -- that call simply hung and timed out, delivering no value either way. Calling
 * `actions/full-refresh` on an already-`ACTIVE` activation separately fails with
 * `INVALID_INPUT: ... responseCode: 428`. Also note: `lastPublishStatus` (which an earlier
 * version of this adapter polled) may never be populated on a real, already-working activation
 * at all -- `status` is the only field to poll.
 */
export class ActivationAdapter extends RestAdapterBase implements AsyncJobAdapter {
  public constructor() {
    super({
      type: 'Activation',
      resourcePlural: 'activations',
      listResponseKey: 'activations',
      updateMethod: 'PUT',
      fieldClassification: {
        segmentApiName: 'replace',
        activationTargetName: 'replace',
        refreshType: 'replace',
        name: 'update',
        activationTargetSubjectConfig: 'update',
        attributesConfig: 'update',
        contactPointsConfig: 'update',
        directDmoFiltersConfig: 'update',
        relatedDmoFiltersConfig: 'update',
      },
      buildLookupQuery: (key) => {
        const name = key.name as string | number | undefined;
        return { filters: name !== undefined ? `name in ${name}` : undefined };
      },
    });
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    const live = await this.read(ctx, id);
    if (!live) throw new Error('Activation is unreadable; safe PUT blocked.');
    return super.update(ctx, id, safePutProperties(this.type, live.properties, properties));
  }

  public async waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>> {
    // create alone drives the activation to ACTIVE on its own, typically within seconds --
    // confirmed live repeatedly (and in a race against this method's own first read: a freshly
    // created activation was still PROCESSING at the time of that read, then settled to ACTIVE
    // entirely on its own well before the explicit actions/full-refresh call below finished --
    // that call simply hung/timed out, delivering no value). Never call actions/full-refresh
    // here: besides being unnecessary, it fails with INVALID_INPUT (responseCode: 428) once
    // already ACTIVE, and the create-already-active race above shows it isn't reliably safe to
    // call even right after create. Just read current status, return immediately if already
    // ACTIVE, and otherwise poll until it reaches ACTIVE on its own.
    const current = await this.read(ctx, id);
    const currentStatus = current?.properties.status as string | undefined;
    if (currentStatus === 'ACTIVE') {
      return current?.properties ?? {};
    }

    return pollUntilStatus({
      read: () => this.read(ctx, id),
      statusOf: (result) => result?.properties.status as string | undefined,
      terminalValues: ['ACTIVE'],
      failureValues: ['ERROR'],
      onPoll: ctx.onJobPoll,
    });
  }
}
