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

export type ResolvedOutputs = Map<string, Record<string, unknown>>;

/**
 * Replaces every `${Type.name.field}` token in `value` with the resolved output recorded for
 * that block (its id, apiName, and any async-job outputs like unifiedDmoApiName/outputField/
 * estimatedPopulation), so adapters receive real values instead of literal reference strings.
 */
export function resolveReferences(value: unknown, outputs: ResolvedOutputs): unknown {
  if (typeof value === 'string') {
    const fullMatch = value.match(new RegExp(`^${REFERENCE_PATTERN.source}$`));
    if (fullMatch) {
      return lookupField(fullMatch[1], fullMatch[2], fullMatch[3], outputs);
    }
    return value.replace(REFERENCE_PATTERN, (_match: string, type: string, name: string, field: string) =>
      stringifyResolved(lookupField(type, name, field, outputs))
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferences(item, outputs));
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveReferences(val, outputs);
    }
    return result;
  }
  return value;
}

function lookupField(type: string, name: string, field: string, outputs: ResolvedOutputs): unknown {
  const key = `${type}.${name}`;
  const resolved = outputs.get(key);
  if (!resolved) {
    throw new Error(`Cannot resolve "\${${key}.${field}}": "${key}" has not been resolved yet`);
  }
  const result = field
    .split('.')
    .reduce<unknown>(
      (item, part) => (item && typeof item === 'object' ? (item as Record<string, unknown>)[part] : undefined),
      resolved
    );
  if (result === undefined) throw new Error(`Reference output ${key}.${field} is unavailable`);
  return result;
}

function stringifyResolved(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
