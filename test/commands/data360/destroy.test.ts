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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Init from '../../../src/commands/data360/init.js';
import Data360Destroy from '../../../src/commands/data360/destroy.js';
import { StatePaths } from '../../../src/state/paths.js';
import { StateStore } from '../../../src/state/store.js';

describe('data360 destroy', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    $$.fakeConnectionRequest = async () => null;
    dir = await mkdtemp(join(tmpdir(), 'data360-destroy-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('refuses to destroy a resource marked protect: true without an explicit override', async () => {
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
      type: 'Segment',
      name: 'guarded',
      id: 'seg-1',
      dependencies: [],
    });
    await store.write(state);

    const manifestPath = join(dir, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        useCase: 'uc',
        dataSpace: 'default',
        resources: [{ kind: 'resource', type: 'Segment', name: 'guarded', properties: { protect: true } }],
      })
    );

    try {
      await Data360Destroy.run(['-f', manifestPath, '--target-org', testOrg.username, '--auto-approve']);
      expect.fail('expected destroy to throw');
    } catch (e) {
      expect((e as Error).message).to.include('protect');
    }
  });
});
