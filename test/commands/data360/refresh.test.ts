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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Init from '../../../src/commands/data360/init.js';
import Data360Refresh from '../../../src/commands/data360/refresh.js';
import { StatePaths } from '../../../src/state/paths.js';
import { StateStore } from '../../../src/state/store.js';

describe('data360 refresh', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-refresh-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it("updates a tracked resource's recorded properties from a simulated out-of-band change, with no manifest consulted", async () => {
    const paths = new StatePaths(dir, testOrg.username, 'default');
    const store = new StateStore(paths);
    const fingerprint = {
      orgId: testOrg.orgId,
      instanceUrl: testOrg.instanceUrl,
      targetOrgAlias: testOrg.username,
      dataSpace: 'default',
    };
    const state = await store.read(fingerprint);
    state.resources.push({
      kind: 'resource',
      type: 'DataModelObject',
      name: 'account_dmo',
      id: '0ZSxx0000000123',
      apiName: 'Account_DMO',
      propertiesHash: 'sha256:stale',
      dependencies: [],
    });
    await store.write(state);

    // Simulate an out-of-band manual change in the org: the live object now has a new field mapping.
    $$.fakeConnectionRequest = async () => ({
      id: '0ZSxx0000000123',
      apiName: 'Account_DMO',
      properties: { apiName: 'Account_DMO', fieldMappings: [{ dmoField: 'NewField', sourceField: 'New' }] },
    });

    const result = await Data360Refresh.run(['--target-org', testOrg.username]);

    expect(result.resourceCount).to.equal(1);
    expect(result.state.resources[0].propertiesHash).to.not.equal('sha256:stale');
  });
});
