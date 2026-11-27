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
const REFERENCE_PATTERN = /\$\{([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+)\}/g;

export type Reference = {
  type: string;
  name: string;
  field: string;
};

/** Recursively scans a value (typically a block's `properties` or `lookup`) for `${Type.name.field}` tokens. */
export function findReferences(value: unknown): Reference[] {
  const refs: Reference[] = [];
  collect(value, refs);
  return refs;
}

function collect(value: unknown, refs: Reference[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(REFERENCE_PATTERN)) {
      refs.push({ type: match[1], name: match[2], field: match[3] });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, refs);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collect(item, refs);
  }
}
