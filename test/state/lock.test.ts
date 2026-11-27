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
import { expect } from 'chai';
import { StateLock } from '../../src/state/lock.js';
import { StateLockedError } from '../../src/state/errors.js';

describe('StateLock', () => {
  let dir: string;
  let lockFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-lock-'));
    lockFile = join(dir, 'state.json.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a second acquire while a lock is held by an in-flight apply', async () => {
    const lock = new StateLock(lockFile);
    await lock.acquire();

    const second = new StateLock(lockFile);
    try {
      await second.acquire();
      expect.fail('expected second acquire to throw');
    } catch (e) {
      expect(e).to.be.instanceOf(StateLockedError);
    }
  });

  it('allows release then re-acquire', async () => {
    const lock = new StateLock(lockFile);
    await lock.acquire();
    await lock.release();

    const second = new StateLock(lockFile);
    await second.acquire();
  });

  it('reclaims a stale lock left by a crashed process', async () => {
    const staleAcquiredAt = new Date(Date.now() - 60_000).toISOString();
    await writeFile(lockFile, JSON.stringify({ pid: 999_999, acquiredAt: staleAcquiredAt }));

    const lock = new StateLock(lockFile, 10_000);
    await lock.acquire();
  });

  it('rejects a lock that is not yet stale', async () => {
    const recentAcquiredAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(lockFile, JSON.stringify({ pid: 999_999, acquiredAt: recentAcquiredAt }));

    const lock = new StateLock(lockFile, 10_000);
    try {
      await lock.acquire();
      expect.fail('expected acquire to throw');
    } catch (e) {
      expect(e).to.be.instanceOf(StateLockedError);
    }
  });
});
