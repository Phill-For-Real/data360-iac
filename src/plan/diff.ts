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
import { FieldClassification } from '../adapters/types.js';
import { ChangeAction } from './types.js';
import { stableStringify } from './properties-hash.js';

export function managedPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const child = value[key];
      return child &&
        typeof child === 'object' &&
        !Array.isArray(child) &&
        !('$secret' in child) &&
        !('$unknownSecret' in child) &&
        Object.keys(child).length
        ? managedPaths(child as Record<string, unknown>, path)
        : [path];
    });
}
export function atPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (item, key) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined),
      value
    );
}
export function isSecret(value: unknown): boolean {
  return !!value && typeof value === 'object' && ('$secret' in value || '$unknownSecret' in value);
}
export function projectManaged(desired: unknown, live: unknown, previous?: unknown): unknown {
  if (isSecret(desired)) return previous ?? desired;
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) return live;
    return desired.map((value, index) =>
      projectManaged(value, live[index], Array.isArray(previous) ? previous[index] : undefined)
    );
  }
  if (desired && typeof desired === 'object' && !isSecret(desired)) {
    if (!live || typeof live !== 'object' || Array.isArray(live)) return live;
    return Object.fromEntries(
      Object.keys(desired).map((key) => [
        key,
        projectManaged(
          (desired as Record<string, unknown>)[key],
          (live as Record<string, unknown>)[key],
          previous && typeof previous === 'object' ? (previous as Record<string, unknown>)[key] : undefined
        ),
      ])
    );
  }
  return live;
}
export type Comparison = { action: ChangeAction; changed: string[]; blockers: string[]; unknown: string[] };
// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
export function compareManaged(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  classification: FieldClassification,
  previous?: Record<string, unknown>,
  clearable: Record<string, unknown> = {},
  unknownPaths: string[] = [],
  setPaths: string[] = []
): Comparison {
  const paths = managedPaths(desired);
  const changed: string[] = [];
  const blockers: string[] = [];
  const unknown: string[] = [];
  for (const path of paths) {
    const value = atPath(desired, path);
    const observed = atPath(live, path);
    if (value === null && clearable[path] !== null)
      blockers.push(`${path}: explicit null has no verified clear contract`);
    if (isSecret(value) || unknownPaths.some((p) => path === p || path.startsWith(`${p}.`))) {
      unknown.push(path);
      if (previous && stableStringify(value) !== stableStringify(atPath(previous, path))) changed.push(path);
    } else if (Array.isArray(value) && Array.isArray(observed) && setPaths.includes(path)) {
      if (
        value.some(
          (desiredItem) =>
            !observed.some(
              (liveItem) => stableStringify(desiredItem) === stableStringify(projectManaged(desiredItem, liveItem))
            )
        )
      )
        changed.push(path);
      const prior = previous ? atPath(previous, path) : undefined;
      if (
        Array.isArray(prior) &&
        prior.some((oldItem) => !value.some((newItem) => stableStringify(oldItem) === stableStringify(newItem))) &&
        !(path in clearable)
      )
        blockers.push(`${path}: removing previously managed set entries has no verified clear/reset contract`);
    } else if (
      stableStringify(value) !==
      stableStringify(projectManaged(value, observed, previous ? atPath(previous, path) : undefined))
    )
      changed.push(path);
  }
  for (const path of previous ? managedPaths(previous) : []) {
    if (atPath(desired, path) !== undefined) continue;
    if (!(path in clearable))
      blockers.push(`${path}: previously managed field omitted; no verified clear/reset operation`);
    else if (stableStringify(atPath(live, path)) !== stableStringify(clearable[path])) changed.push(path);
  }
  const action = changed.length
    ? changed.some((p) => classification[p.split('.')[0]] === 'replace')
      ? 'replace'
      : 'update-in-place'
    : 'no-op';
  return { action, changed, blockers, unknown };
}
export function classifyChange(
  desired: Record<string, unknown>,
  live: Record<string, unknown>,
  classification: FieldClassification
): ChangeAction {
  return compareManaged(desired, live, classification).action;
}
export function apiProperties(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'protect'));
}

/** Only adapter-declared clear values may be inserted; omission itself never clears a field. */
export function removalPayload(
  desired: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  clearable: Record<string, unknown> = {}
): Record<string, unknown> {
  const payload = structuredClone(desired);
  for (const path of previous ? managedPaths(previous) : []) {
    if (atPath(desired, path) !== undefined) continue;
    if (!(path in clearable)) throw new Error(`${path}: no verified clear/reset operation`);
    const parts = path.split('.');
    let cursor = payload;
    for (const key of parts.slice(0, -1)) {
      cursor[key] ??= {};
      cursor = cursor[key] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = clearable[path];
  }
  return payload;
}
