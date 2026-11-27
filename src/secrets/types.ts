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
export type SecretSource = 'env' | 'keychain';

export type SecretRef = {
  source: SecretSource;
  key: string;
};

export type SecretMarker = {
  $secret: SecretRef;
};

export function isSecretMarker(value: unknown): value is SecretMarker {
  if (typeof value !== 'object' || value === null || !('$secret' in value)) return false;
  const marker = value.$secret;
  return (
    typeof marker === 'object' &&
    marker !== null &&
    typeof (marker as Partial<SecretRef>).source === 'string' &&
    typeof (marker as Partial<SecretRef>).key === 'string'
  );
}

/** A single small interface secret sources resolve through, so each is swappable and mockable. */
export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}
