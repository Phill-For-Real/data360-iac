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
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { StatePaths } from '../../src/state/paths.js';
import { StateStore } from '../../src/state/store.js';
import { OrgFingerprintMismatchError } from '../../src/state/errors.js';
import { OrgFingerprint, StateFile } from '../../src/state/types.js';

const FINGERPRINT: OrgFingerprint = {
  orgId: '00Dxx0000000001EAA',
  instanceUrl: 'https://example.my.salesforce.com',
  targetOrgAlias: 'data360-prod',
  dataSpace: 'default',
};

describe('StateStore', () => {
  let dir: string;
  let paths: StatePaths;
  let store: StateStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-state-'));
    paths = new StatePaths(dir, 'data360-prod', 'default');
    store = new StateStore(paths);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('init creates an empty state file with a generated lineage', async () => {
    const state = await store.init(FINGERPRINT);
    expect(state.serial).to.equal(0);
    expect(state.resources).to.deep.equal([]);
    expect(state.lineage).to.be.a('string').with.length.greaterThan(0);
    expect(await store.exists()).to.equal(true);
  });

  it('write increments serial and rotates the previous file to .backup', async () => {
    const initial = await store.init(FINGERPRINT);
    const afterFirstWrite = await store.write({ ...initial, resources: [] });
    expect(afterFirstWrite.serial).to.equal(1);

    const backupContents = JSON.parse(await readFile(paths.backupFile, 'utf8')) as StateFile;
    expect(backupContents.serial).to.equal(0);

    const afterSecondWrite = await store.write(afterFirstWrite);
    expect(afterSecondWrite.serial).to.equal(2);

    const backupAfterSecond = JSON.parse(await readFile(paths.backupFile, 'utf8')) as StateFile;
    expect(backupAfterSecond.serial).to.equal(1);
  });

  it('recovers from a corrupted state file by falling back to .backup', async () => {
    const initial = await store.init(FINGERPRINT);
    await store.write(initial);

    await writeFile(paths.stateFile, '{ not valid json');

    const recovered = await store.read(FINGERPRINT);
    expect(recovered.serial).to.equal(0);
  });

  it('hard-fails when the live org fingerprint does not match the one recorded in state', async () => {
    await store.init(FINGERPRINT);

    try {
      await store.read({ ...FINGERPRINT, orgId: '00Dxx0000000999EAA' });
      expect.fail('expected read to throw');
    } catch (e) {
      expect(e).to.be.instanceOf(OrgFingerprintMismatchError);
    }
  });
});
