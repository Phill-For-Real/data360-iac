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
import { expect } from 'chai';
import { resolveSecrets } from '../../src/secrets/resolve-secrets.js';
import { EnvSecretSource } from '../../src/secrets/env-secret-source.js';

describe('resolveSecrets', () => {
  it('replaces a $secret marker with the value resolved from its source', async () => {
    const env = new EnvSecretSource({ FLEET_S3_SECRET_ACCESS_KEY: 'super-secret' });
    const result = await resolveSecrets(
      { accessKeyId: 'AKIA123', secretAccessKey: { $secret: { source: 'env', key: 'FLEET_S3_SECRET_ACCESS_KEY' } } },
      { env, keychain: { resolve: () => Promise.reject(new Error('not used')) } }
    );
    expect(result).to.deep.equal({ accessKeyId: 'AKIA123', secretAccessKey: 'super-secret' });
  });

  it('leaves non-secret values untouched', async () => {
    const env = new EnvSecretSource({});
    const result = await resolveSecrets(
      { a: 1, b: ['x', 'y'], c: { nested: true } },
      { env, keychain: { resolve: () => Promise.reject(new Error('not used')) } }
    );
    expect(result).to.deep.equal({ a: 1, b: ['x', 'y'], c: { nested: true } });
  });

  it('throws when the referenced environment variable is not set', async () => {
    const env = new EnvSecretSource({});
    try {
      await resolveSecrets(
        { $secret: { source: 'env', key: 'MISSING' } },
        { env, keychain: { resolve: () => Promise.reject(new Error('not used')) } }
      );
      expect.fail('expected resolveSecrets to throw');
    } catch (e) {
      expect((e as Error).message).to.include('MISSING');
    }
  });
});
