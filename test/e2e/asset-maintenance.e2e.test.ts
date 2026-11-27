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
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Init from '../../src/commands/data360/init.js';
import Data360Validate from '../../src/commands/data360/validate.js';
import Data360Plan from '../../src/commands/data360/plan.js';
import Data360Apply from '../../src/commands/data360/apply.js';
import Data360Destroy from '../../src/commands/data360/destroy.js';
import { loadManifest } from '../../src/manifest/loader.js';
import { StatePaths } from '../../src/state/paths.js';
import { STATE_FORMAT_VERSION, StateFile } from '../../src/state/types.js';
import { buildFakeOrg } from '../support/fake-org-builder.js';
import { asFakeConnectionRequest } from './fake-org.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', 'fixtures', 'asset-maintenance.json');

describe('Asset Maintenance end-to-end fixture', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let dir: string;
  let originalCwd: string;

  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    process.env.FLEET_S3_SECRET_ACCESS_KEY = 'test-secret-value';
    process.env.FLEET_S3_ACCESS_KEY_ID = 'test-access-key-id';
    dir = await mkdtemp(join(tmpdir(), 'data360-e2e-'));
    originalCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
    $$.restore();
  });

  it('runs validate -> plan -> apply -> plan (no-op), and blocks unreviewed rule destruction', async () => {
    const result = await Data360Validate.run(['-f', FIXTURE_PATH]);
    expect(result).to.deep.equal({ valid: true, resourceCount: 31 });

    await Data360Init.run(['--target-org', testOrg.username]);

    const manifest = await loadManifest(FIXTURE_PATH);
    const fakeOrg = buildFakeOrg(manifest);
    $$.fakeConnectionRequest = asFakeConnectionRequest(fakeOrg);

    const plan1 = await Data360Plan.run(['-f', FIXTURE_PATH, '--target-org', testOrg.username]);
    expect(plan1.summary).to.deep.equal({
      create: 26,
      update: 0,
      replace: 0,
      destroy: 0,
      noOp: 0,
      total: 26,
    });

    const applyResult = await Data360Apply.run([
      '-f',
      FIXTURE_PATH,
      '--target-org',
      testOrg.username,
      '--auto-approve',
    ]);
    expect(applyResult.failure).to.be.undefined;
    expect(applyResult.completed).to.have.lengthOf(26);

    const plan2 = await Data360Plan.run(['-f', FIXTURE_PATH, '--target-org', testOrg.username]);
    expect(plan2.summary, JSON.stringify(plan2.changes.filter((c) => c.action !== 'no-op'))).to.deep.equal({
      create: 0,
      update: 0,
      replace: 0,
      destroy: 0,
      noOp: 26,
      total: 26,
    });
    expect(plan2.adoptionCandidates).to.have.lengthOf(0);

    const beforeUnchanged = fakeOrg.calls.filter((request) => request.method !== 'GET').length;
    await Data360Apply.run(['-f', FIXTURE_PATH, '--target-org', testOrg.username, '--auto-approve']);
    expect(fakeOrg.calls.filter((request) => request.method !== 'GET')).to.have.length(beforeUnchanged);

    const paths = new StatePaths(dir, testOrg.username, 'default');
    const stateFileContents = JSON.parse(await readFile(paths.stateFile, 'utf8')) as StateFile;
    expect(stateFileContents.formatVersion).to.equal(STATE_FORMAT_VERSION);
    expect(stateFileContents.orgFingerprint).to.include({ targetOrgAlias: testOrg.username, dataSpace: 'default' });
    expect(stateFileContents.lineage).to.be.a('string').with.length.greaterThan(0);
    expect(stateFileContents.serial).to.be.a('number').that.is.greaterThan(0);
    expect(stateFileContents.resources).to.have.lengthOf(26);
    for (const resource of stateFileContents.resources) {
      expect(resource).to.include.all.keys(
        'kind',
        'type',
        'name',
        'declaredBy',
        'id',
        'apiName',
        'propertiesHash',
        'dependencies',
        'adopted',
        'lastAppliedAt'
      );
      expect(resource.intentVersion).to.equal(1);
      expect(resource.lastAppliedIntent).to.be.an('object');
      expect(resource.id).to.be.a('string').with.length.greaterThan(0);
    }

    // Section 11's protect: true on Segment/Activation is a deliberate tool-level guard; the
    // explicit override to destroy a protected resource is editing the manifest to drop the flag,
    // the same discipline Terraform's prevent_destroy requires.
    const fixtureContents = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as {
      resources: Array<{ kind?: string; properties?: Record<string, unknown> }>;
    };
    for (const resource of fixtureContents.resources) {
      if ((resource.kind ?? 'resource') !== 'resource') continue;
      delete resource.properties!.protect;
    }
    const unprotectedManifestPath = join(dir, 'unprotected-manifest.json');
    await writeFile(unprotectedManifestPath, JSON.stringify(fixtureContents));

    const beforeDeleteCount = fakeOrg.calls.filter((request) => request.method === 'DELETE').length;
    let blocked = false;
    try {
      await Data360Destroy.run(['-f', unprotectedManifestPath, '--target-org', testOrg.username, '--auto-approve']);
    } catch (error) {
      blocked = true;
      expect((error as Error).message).to.match(/cascade|Protected/i);
    }
    expect(blocked).to.equal(true);
    expect(fakeOrg.calls.filter((request) => request.method === 'DELETE')).to.have.length(beforeDeleteCount);
    const finalStateContents = JSON.parse(await readFile(paths.stateFile, 'utf8')) as StateFile;
    expect(finalStateContents.resources).to.have.lengthOf(26);
  });
});
