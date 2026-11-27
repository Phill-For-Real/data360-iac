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
import Data360Init from '../../src/commands/data360/init.js';
import Data360Validate from '../../src/commands/data360/validate.js';
import Data360Plan from '../../src/commands/data360/plan.js';
import Data360Apply from '../../src/commands/data360/apply.js';
import { loadManifest } from '../../src/manifest/loader.js';
import { buildFakeOrg } from '../support/fake-org-builder.js';
import { asFakeConnectionRequest } from './fake-org.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(TEST_DIR, '..', '..', 'examples');

/**
 * Every example manifest in examples/ *other than* asset-maintenance.json and its directory
 * split (already covered end to end by asset-maintenance.e2e.test.ts against
 * test/fixtures/asset-maintenance.json, which intentionally still declares an
 * `ObjectAccessGrant` block -- unlike examples/asset-maintenance.json -- to keep exercising that
 * adapter's code path; see examples/asset-maintenance.json's governance section for why it was
 * dropped there). Proves each one actually runs through the real command path against a fake
 * org, not just that it parses/validates.
 */
describe('example manifests end to end', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    dir = await mkdtemp(join(tmpdir(), 'data360-examples-e2e-'));
    originalCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('minimal-connection.json: validate -> plan -> apply runs end to end', async () => {
    const manifestPath = join(EXAMPLES_DIR, 'minimal-connection.json');

    const validateResult = await Data360Validate.run(['-f', manifestPath]);
    expect(validateResult).to.deep.equal({ valid: true, resourceCount: 1 });

    await Data360Init.run(['--target-org', testOrg.username]);

    const manifest = await loadManifest(manifestPath);
    const fakeOrg = buildFakeOrg(manifest);
    $$.fakeConnectionRequest = asFakeConnectionRequest(fakeOrg);

    const plan = await Data360Plan.run(['-f', manifestPath, '--target-org', testOrg.username]);
    expect(plan.summary).to.deep.equal({ create: 1, update: 0, replace: 0, destroy: 0, noOp: 0, total: 1 });

    const applyResult = await Data360Apply.run([
      '-f',
      manifestPath,
      '--target-org',
      testOrg.username,
      '--auto-approve',
    ]);
    expect(applyResult.failure).to.be.undefined;
    expect(applyResult.completed).to.have.lengthOf(1);
  });

  it('customer-service-data-reference.json: validate -> plan -> apply resolves its data block', async () => {
    const manifestPath = join(EXAMPLES_DIR, 'customer-service-data-reference.json');

    const validateResult = await Data360Validate.run(['-f', manifestPath]);
    expect(validateResult).to.deep.equal({ valid: true, resourceCount: 4 });

    await Data360Init.run(['--target-org', testOrg.username]);

    const manifest = await loadManifest(manifestPath);
    const fakeOrg = buildFakeOrg(manifest);
    // The manifest's one `kind: "data"` block looks up a DMO that already exists live, by name
    // -- wire that lookup to report it found, since buildFakeOrg only wires adoption-lookups
    // ("not found yet") for `kind: "resource"` blocks.
    fakeOrg.on('GET', '/ssot/data-model-objects', () => ({
      dataModelObject: [{ id: 'dmo-existing-1', name: 'Account_DMO__dlm' }],
    }));
    $$.fakeConnectionRequest = asFakeConnectionRequest(fakeOrg);

    const plan = await Data360Plan.run(['-f', manifestPath, '--target-org', testOrg.username]);
    expect(plan.summary).to.deep.equal({ create: 3, update: 0, replace: 0, destroy: 0, noOp: 0, total: 3 });

    const applyResult = await Data360Apply.run([
      '-f',
      manifestPath,
      '--target-org',
      testOrg.username,
      '--auto-approve',
    ]);
    expect(applyResult.failure).to.be.undefined;
    expect(applyResult.completed).to.have.lengthOf(3);
  });
});
