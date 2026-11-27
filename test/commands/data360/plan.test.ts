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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Init from '../../../src/commands/data360/init.js';
import Data360Plan from '../../../src/commands/data360/plan.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', '..', 'fixtures', 'asset-maintenance.json');

describe('data360 plan', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    // The default fakeConnectionRequest resolves to `{ records: [] }`, which isn't a shape any
    // adapter understands as "no live match". Make every lookup resolve to undefined instead,
    // so the plan computed here is a clean, unmocked-network set of 25 creates.
    $$.fakeConnectionRequest = async () => null;
    dir = await mkdtemp(join(tmpdir(), 'data360-plan-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('plans 26 fresh creates against an org with nothing tracked and nothing live', async () => {
    const plan = await Data360Plan.run(['-f', FIXTURE_PATH, '--target-org', testOrg.username]);

    expect(plan.summary).to.deep.equal({
      create: 26,
      update: 0,
      replace: 0,
      destroy: 0,
      noOp: 0,
      total: 26,
    });
    expect(plan.adoptionCandidates).to.have.lengthOf(0);
  });
});
