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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { SfError } from '@salesforce/core';
import Data360Validate from '../../../src/commands/data360/validate.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', '..', 'fixtures', 'asset-maintenance.json');

describe('data360 validate', () => {
  it('reports the Asset Maintenance manifest as valid with 30 resources', async () => {
    const result = await Data360Validate.run(['-f', FIXTURE_PATH]);
    expect(result).to.deep.equal({ valid: true, resourceCount: 31 });
  });

  it('throws when the manifest file does not exist', async () => {
    const dir = join(TEST_DIR, '..', '..', 'fixtures');
    try {
      await Data360Validate.run(['-f', join(dir, 'nonexistent-manifest-for-test.json')]);
      expect.fail('expected validate to throw');
    } catch (e) {
      expect(e).to.exist;
    }
  });

  it('fails with an SfError (non-zero exit) on a manifest with an unresolved reference', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'data360-validate-'));
    const manifestPath = join(dir, 'manifest.json');
    try {
      await writeFile(
        manifestPath,
        JSON.stringify({
          useCase: 'uc',
          dataSpace: 'default',
          resources: [
            {
              kind: 'resource',
              type: 'Segment',
              name: 'a',
              properties: { ref: '${Connection.missing.id}' },
            },
          ],
        })
      );

      try {
        await Data360Validate.run(['-f', manifestPath]);
        expect.fail('expected validate to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(SfError);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
