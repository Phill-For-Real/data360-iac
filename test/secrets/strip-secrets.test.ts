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
import { stripSecrets } from '../../src/plan/strip-secrets.js';
import { computePropertiesHash } from '../../src/plan/properties-hash.js';

describe('stripSecrets / propertiesHash interaction', () => {
  it('excludes a $secret-referenced value from propertiesHash entirely', () => {
    const before = {
      connectorType: 'S3',
      authProperties: {
        accessKeyId: 'AKIA123',
        secretAccessKey: { $secret: { source: 'env', key: 'FLEET_S3_SECRET_ACCESS_KEY' } },
      },
    };

    const hashBefore = computePropertiesHash(stripSecrets(before) as Record<string, unknown>);

    // Simulate the env var's value changing between two plan runs -- the $secret marker itself
    // (source/key) is unchanged, which is all stripSecrets ever looks at.
    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'old-value';
    const afterOld = stripSecrets(before) as Record<string, unknown>;
    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'new-value';
    const afterNew = stripSecrets(before) as Record<string, unknown>;

    expect(computePropertiesHash(afterOld)).to.equal(hashBefore);
    expect(computePropertiesHash(afterNew)).to.equal(hashBefore);
  });
});
