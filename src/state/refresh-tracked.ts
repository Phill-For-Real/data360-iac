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
import { AdapterContext } from '../adapters/types.js';
import { getAdapter } from '../adapters/registry.js';
import { computePropertiesHash } from '../plan/properties-hash.js';
import { stripSecrets } from '../plan/strip-secrets.js';
import { StateFile, StateResourceEntry } from './types.js';

/**
 * Standalone reconciliation pass (Section 7 / Section 10's "refresh in detail"): re-fetches the
 * live state of every resource already tracked in state and updates its recorded properties --
 * no manifest, no diff against desired configuration. Used both by `data360 refresh` directly
 * and as the first step of every `plan`.
 */
export async function refreshTrackedResources(state: StateFile, ctx: AdapterContext): Promise<StateFile> {
  const refreshed: StateResourceEntry[] = [];
  for (const entry of state.resources) {
    if (!entry.id) {
      refreshed.push(entry);
      continue;
    }
    const adapter = getAdapter(entry.type);
    // eslint-disable-next-line no-await-in-loop -- bounded, predictable request rate against Connect REST (Section 13).
    const live = await adapter.read(ctx, entry.id);
    if (!live) {
      refreshed.push(entry);
      continue;
    }
    const sanitized = stripSecrets(live.properties) as Record<string, unknown>;
    refreshed.push({
      ...entry,
      apiName: live.apiName ?? entry.apiName,
      propertiesHash: computePropertiesHash(sanitized),
    });
  }
  return { ...state, resources: refreshed };
}
