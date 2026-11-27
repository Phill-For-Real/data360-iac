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
import { stubSfCommandUx, stubPrompter } from '@salesforce/sf-plugins-core';
import Data360Init from '../../../src/commands/data360/init.js';
import Data360Apply from '../../../src/commands/data360/apply.js';

describe('data360 apply - adoption confirmation', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;
  let manifestPath: string;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-apply-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    await Data360Init.run(['--target-org', testOrg.username]);

    manifestPath = join(dir, 'manifest.json');
    await writeFile(
      manifestPath,
      JSON.stringify({
        useCase: 'uc',
        dataSpace: 'default',
        resources: [
          {
            kind: 'resource',
            type: 'Connection',
            name: 'core_crm_connection',
            properties: { connectorType: 'SalesforceCRM', name: 'core_crm_connection' },
          },
        ],
      })
    );

    // Simulate an adoption candidate: a live Connection already exists with this devName. Every
    // request (the adoption lookup, and the refresh-by-id read on a subsequent plan) sees the
    // same list-shaped response, matching the real /ssot/connections collection shape.
    $$.fakeConnectionRequest = async () => ({
      connections: [{ id: 'conn-1', name: 'core_crm_connection', connectorType: 'SalesforceCRM' }],
    });

    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('fails conservatively in a non-interactive (CI) session without --adopt', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    try {
      await Data360Apply.run(['-f', manifestPath, '--target-org', testOrg.username, '--auto-approve']);
      expect.fail('expected apply to throw');
    } catch (e) {
      expect((e as Error).message).to.include('non-interactive');
    }
  });

  it('proceeds without prompting when --adopt is passed in a non-interactive session', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const result = await Data360Apply.run([
      '-f',
      manifestPath,
      '--target-org',
      testOrg.username,
      '--auto-approve',
      '--adopt',
    ]);

    expect(result.failure).to.be.undefined;
  });

  it('prompts for confirmation in an interactive session and proceeds when confirmed', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const prompterStubs = stubPrompter($$.SANDBOX);
    prompterStubs.confirm.resolves(true);

    const result = await Data360Apply.run(['-f', manifestPath, '--target-org', testOrg.username]);

    expect(result.failure).to.be.undefined;
    expect(prompterStubs.confirm.called).to.equal(true);
  });

  it('prompts for confirmation in an interactive session and aborts when declined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const prompterStubs = stubPrompter($$.SANDBOX);
    prompterStubs.confirm.resolves(false);

    try {
      await Data360Apply.run(['-f', manifestPath, '--target-org', testOrg.username]);
      expect.fail('expected apply to throw');
    } catch (e) {
      expect((e as Error).message).to.include('not confirmed');
    }
  });
});
