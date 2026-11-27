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
/** Retain references and credential shape, never literal credential material. */
export function safeIntent(value: unknown, sensitive = false): unknown {
  if (Array.isArray(value)) return value.map((v) => safeIntent(v, sensitive));
  if (!value || typeof value !== 'object') return sensitive && value !== undefined ? { $unknownSecret: true } : value;
  const object = value as Record<string, unknown>;
  if ('$unknownSecret' in object) return { $unknownSecret: true };
  if ('$secret' in object) {
    const descriptor = object.$secret as { source?: unknown; key?: unknown };
    return { $secret: { source: descriptor.source, key: descriptor.key } };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      safeIntent(
        child,
        (sensitive && key !== 'name') || /credential|password|token|secret|authorization|accessKey/i.test(key)
      ),
    ])
  );
}
