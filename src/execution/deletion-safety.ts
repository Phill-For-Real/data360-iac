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
import { memberPath } from '../adapters/real-paths.js';
import { StateFile } from '../state/types.js';
import { CascadeReview, SafetyBlocker } from '../plan/types.js';
import { computePropertiesHash } from '../plan/properties-hash.js';
import { convertObserved } from '../adapters/configuration.js';

export class SafetyError extends Error {
  public readonly code = 'SAFETY_BLOCKED';
  public constructor(public readonly reasons: SafetyBlocker[]) {
    super(reasons.map((r) => `${r.key}: ${r.code}: ${r.message}`).join('; '));
  }
}
export async function reviewDeletions(
  state: StateFile,
  keys: Set<string>,
  ctx: AdapterContext,
  protectedKeys = new Set<string>()
): Promise<{ cascades: CascadeReview[]; blockers: SafetyBlocker[] }> {
  const cascades: CascadeReview[] = [];
  const blockers: SafetyBlocker[] = [];
  const parents = state.resources.filter((e) => e.type === 'AccessPolicy' && keys.has(`${e.type}.${e.name}`));
  for (const entry of state.resources.filter((e) => keys.has(`${e.type}.${e.name}`))) {
    const key = `${entry.type}.${entry.name}`;
    if (entry.protected || protectedKeys.has(key))
      blockers.push({ key, code: 'PROTECTED', message: 'Protected resource cannot be deleted.' });
    if (
      getAdapter(entry.type).deletionCapability === 'parent-cascade-only' &&
      !parents.some((p) => entry.id?.startsWith(`${String(p.id)}::`))
    ) {
      blockers.push({
        key,
        code: 'UNSUPPORTED_DELETE',
        message: 'No standalone AccessPolicyRule deletion API. State is retained.',
      });
    }
  }
  for (const parent of parents) {
    const parentKey = `${parent.type}.${parent.name}`;
    try {
      // The verified member GET embeds the policy's complete rules array; no invented list endpoint.
      // eslint-disable-next-line no-await-in-loop -- enumerate each explicitly deleted parent.
      const raw = await ctx.client.request<Record<string, unknown>>({
        method: 'GET',
        path: memberPath('data-governance/access-policies', parent.id!),
      });
      if (
        raw.name !== parent.id ||
        !Array.isArray(raw.rules) ||
        (typeof raw.totalSize === 'number' && raw.totalSize !== raw.rules.length) ||
        raw.nextPageUrl ||
        raw.rules.some(
          (r: unknown) => !r || typeof r !== 'object' || typeof (r as Record<string, unknown>).name !== 'string'
        )
      )
        throw new Error('incomplete');
      const rules = raw.rules
        .map((r: Record<string, unknown>) => {
          const id = `${String(parent.id)}::${String(r.name)}`;
          const tracked = state.resources.find((e) => e.type === 'AccessPolicyRule' && e.id === id);
          const managedKey = tracked ? `${tracked.type}.${tracked.name}` : undefined;
          const protectedRule =
            r.protect === true || !!tracked?.protected || (!!managedKey && protectedKeys.has(managedKey));
          return {
            id,
            name: String(r.name),
            managedKey,
            protected: protectedRule,
            fingerprint: computePropertiesHash(convertObserved('AccessPolicyRule', r).properties),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      if (new Set(rules.map((r) => r.id)).size !== rules.length) throw new Error('ambiguous');
      if (rules.some((r) => r.protected))
        blockers.push({ key: parentKey, code: 'PROTECTED_CASCADE', message: 'Cascade includes a protected rule.' });
      cascades.push({
        parentKey,
        parentId: parent.id!,
        rules,
        scopeHash: computePropertiesHash({ parentId: parent.id, rules }),
      });
    } catch {
      blockers.push({
        key: parentKey,
        code: 'INCOMPLETE_CASCADE',
        message: 'Complete live rule inventory is unavailable; parent deletion blocked.',
      });
    }
  }
  return { cascades, blockers };
}
export async function checkDeletionReview(
  state: StateFile,
  keys: Set<string>,
  ctx: AdapterContext,
  reviewed: CascadeReview[] = [],
  approvals: string[] = [],
  protectedKeys = new Set<string>()
): Promise<void> {
  const current = await reviewDeletions(state, keys, ctx, protectedKeys);
  const reasons = [...current.blockers];
  for (const cascade of current.cascades) {
    const original = reviewed.find((r) => r.parentKey === cascade.parentKey);
    if (original?.scopeHash !== cascade.scopeHash || !approvals.includes(cascade.scopeHash))
      reasons.push({
        key: cascade.parentKey,
        code: 'CASCADE_REVIEW_REQUIRED',
        message: `Review exact cascade scope and pass --approve-cascade ${cascade.scopeHash}. Changed scope needs a new review.`,
      });
  }
  if (reasons.length) throw new SafetyError(reasons);
}
