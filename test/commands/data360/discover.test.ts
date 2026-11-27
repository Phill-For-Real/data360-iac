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
import { join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Discover from '../../../src/commands/data360/discover.js';
import { DISCOVER_ENDPOINTS } from '../../../src/discover/endpoints.js';

describe('data360 discover', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-discover-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    // Every non-skipped, non-Connections GET resolves to an empty-ish shape; Connections'
    // connectorType-loop fetches resolve the same way since connectorInfoList is empty.
    $$.fakeConnectionRequest = async () => ({ items: [], connectorInfoList: [] });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('resolves the target org, writes files under the given output dir, and reports counts', async () => {
    const outputDir = join(dir, 'out');
    const result = await Data360Discover.run(['--target-org', testOrg.username, '-d', outputDir]);

    const skippedCount = DISCOVER_ENDPOINTS.filter((e) => e.skipReason).length;
    expect(result.outputDir).to.equal(outputDir);
    expect(result.skipped).to.equal(skippedCount);
    expect(result.errored).to.equal(0);
    expect(result.fetched).to.equal(DISCOVER_ENDPOINTS.length - skippedCount);

    const summary = JSON.parse(await readFile(join(outputDir, 'summary.json'), 'utf8'));
    expect(summary).to.have.lengthOf(DISCOVER_ENDPOINTS.length);
  });

  it('defaults the output directory to ./data360-discovery', async () => {
    const result = await Data360Discover.run(['--target-org', testOrg.username]);
    expect(result.outputDir).to.equal('./data360-discovery');

    const summary = JSON.parse(await readFile(join(dir, 'data360-discovery', 'summary.json'), 'utf8'));
    expect(summary).to.have.lengthOf(DISCOVER_ENDPOINTS.length);
  });
});
