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
import Data360Init from '../../../../src/commands/data360/init.js';
import Data360StateList from '../../../../src/commands/data360/state/list.js';
import Data360StateShow from '../../../../src/commands/data360/state/show.js';
import Data360StateRm from '../../../../src/commands/data360/state/rm.js';
import { StatePaths } from '../../../../src/state/paths.js';
import { StateStore } from '../../../../src/state/store.js';

describe('data360 state', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-state-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  async function seedResource(): Promise<void> {
    const paths = new StatePaths(dir, testOrg.username, 'default');
    const store = new StateStore(paths);
    const state = await store.read({
      orgId: testOrg.orgId,
      instanceUrl: testOrg.instanceUrl,
      targetOrgAlias: testOrg.username,
      dataSpace: 'default',
    });
    state.resources.push({
      kind: 'resource',
      type: 'DataModelObject',
      name: 'account_dmo',
      id: '0ZSxx0000000123',
      apiName: 'Account_DMO',
      dependencies: [],
    });
    await store.write(state);
  }

  it('list returns every resource tracked in state', async () => {
    await seedResource();
    const result = await Data360StateList.run(['--target-org', testOrg.username]);
    expect(result.resources).to.have.lengthOf(1);
    expect(result.resources[0]).to.include({ type: 'DataModelObject', name: 'account_dmo' });
  });

  it('show returns the entry for one named resource', async () => {
    await seedResource();
    const result = await Data360StateShow.run(['DataModelObject.account_dmo', '--target-org', testOrg.username]);
    expect(result).to.include({ apiName: 'Account_DMO' });
  });

  it('rm removes the entry from state without touching the live org', async () => {
    await seedResource();
    const result = await Data360StateRm.run(['DataModelObject.account_dmo', '--target-org', testOrg.username]);
    expect(result).to.deep.equal({ removed: 'DataModelObject.account_dmo', remoteDeleted: false });

    const afterRm = await Data360StateList.run(['--target-org', testOrg.username]);
    expect(afterRm.resources).to.have.lengthOf(0);
  });
});
