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
import { SecretResolver, SecretSource, isSecretMarker } from './types.js';

export type SecretResolverRegistry = Record<SecretSource, SecretResolver>;

/** Recursively replaces every `{ "$secret": { source, key } }` marker with its resolved value. */
export async function resolveSecrets(value: unknown, resolvers: SecretResolverRegistry): Promise<unknown> {
  if (isSecretMarker(value)) {
    const resolver = resolvers[value.$secret.source];
    if (!resolver) {
      throw new Error(`$secret: no resolver registered for source "${value.$secret.source}"`);
    }
    return resolver.resolve(value.$secret);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveSecrets(item, resolvers)));
  }
  if (typeof value === 'object' && value !== null) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, val]) => [key, await resolveSecrets(val, resolvers)] as const)
    );
    return Object.fromEntries(entries);
  }
  return value;
}
