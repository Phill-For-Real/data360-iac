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
import { SecretRef, SecretResolver } from './types.js';

/**
 * OS-keychain secret source for interactive use. Behind the same SecretResolver interface as
 * EnvSecretSource so it's swappable and mockable; this is a stub until a concrete keychain
 * integration (e.g. via @salesforce/core's Keychain) is wired in.
 */
export class KeychainSecretSource implements SecretResolver {
  public constructor(private readonly backend: (key: string) => Promise<string | undefined>) {}

  public async resolve(ref: SecretRef): Promise<string> {
    const value = await this.backend(ref.key);
    if (value === undefined) {
      throw new Error(`$secret: no keychain entry found for "${ref.key}"`);
    }
    return value;
  }
}
