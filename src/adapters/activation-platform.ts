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
import { AdapterContext, AsyncJobAdapter } from './types.js';
import { actionPath } from './real-paths.js';
import { postAction, pollUntilStatus } from './status-poll.js';

/**
 * The full-featured activation destination (`/ssot/activation-platforms`): attribute mapping,
 * refresh settings, enable/disable/publish/retry-sync actions. Request/response bodies are
 * passed through untouched -- this plugin is a harness for the real API's full surface, not a
 * narrowed-down subset. See ActivationTargetAdapter for the simpler connector-style counterpart.
 *
 * Real `status` values are capitalized, not SCREAMING_CASE (`Active`/`Error`/`Processing`,
 * confirmed against the official API reference) -- `failureValues: ['Error']` was already
 * correct; `terminalValues` is fixed to `['Active']` to match.
 */
export class ActivationPlatformAdapter extends RestAdapterBase implements AsyncJobAdapter {
  public constructor() {
    super({
      type: 'ActivationPlatform',
      resourcePlural: 'activation-platforms',
      listResponseKey: 'activationPlatforms',
      fieldClassification: {
        platformType: 'replace',
        name: 'replace',
        label: 'update',
        description: 'update',
        outputFormat: 'update',
        outputGrouping: 'update',
        refreshSettings: 'update',
        connector: 'update',
        activationPlatformAttributes: 'update',
        fields: 'update',
        customMetadata: 'update',
        additionalMetadata: 'update',
      },
      buildLookupQuery: () => ({ activationPlatformView: 'Developer' }),
    });
  }

  public async waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>> {
    await postAction(ctx, actionPath(this.resourcePlural, id, 'publish'));
    return pollUntilStatus({
      read: () => this.read(ctx, id),
      statusOf: (result) => result?.properties.status as string | undefined,
      terminalValues: ['Active'],
      failureValues: ['Error'],
      onPoll: ctx.onJobPoll,
    });
  }
}
