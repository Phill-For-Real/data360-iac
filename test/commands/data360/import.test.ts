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
import Data360Import from '../../../src/commands/data360/import.js';
import Data360StateList from '../../../src/commands/data360/state/list.js';

describe('data360 import', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-import-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('finds a previously-untracked object and produces a correct state entry plus JSON block', async () => {
    $$.fakeConnectionRequest = async () => ({ id: '0ZSxx0000000123', name: 'Account_DMO', category: 'Profile' });

    const result = await Data360Import.run([
      '-t',
      'DataModelObject',
      '-n',
      'account_dmo',
      '--api-name',
      'Account_DMO',
      '--target-org',
      testOrg.username,
    ]);

    expect(result.entry).to.include({
      type: 'DataModelObject',
      name: 'account_dmo',
      id: '0ZSxx0000000123',
      apiName: 'Account_DMO',
      adopted: true,
    });

    const parsedBlock = JSON.parse(result.startingBlock);
    expect(parsedBlock).to.deep.equal({
      kind: 'resource',
      type: 'DataModelObject',
      name: 'account_dmo',
      properties: { name: 'Account_DMO', category: 'Profile' },
    });

    const list = await Data360StateList.run(['--target-org', testOrg.username]);
    expect(list.resources).to.have.lengthOf(1);
  });

  it('fails when the logical name is already tracked in state', async () => {
    $$.fakeConnectionRequest = async () => ({ id: '0ZSxx0000000123', name: 'Account_DMO' });

    const args = [
      '-t',
      'DataModelObject',
      '-n',
      'account_dmo',
      '--api-name',
      'Account_DMO',
      '--target-org',
      testOrg.username,
    ];
    await Data360Import.run(args);

    try {
      await Data360Import.run(args);
      expect.fail('expected the second import to throw');
    } catch (e) {
      expect((e as Error).message).to.include('already tracked');
    }
  });

  it('fails with a clear error when no live object matches the given API name', async () => {
    $$.fakeConnectionRequest = async () => null;

    try {
      await Data360Import.run([
        '-t',
        'DataModelObject',
        '-n',
        'missing_dmo',
        '--api-name',
        'Missing_DMO',
        '--target-org',
        testOrg.username,
      ]);
      expect.fail('expected import to throw');
    } catch (e) {
      expect((e as Error).message).to.include('No live');
    }
  });
});
