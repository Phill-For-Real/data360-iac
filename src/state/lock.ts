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
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { StateLockedError } from './errors.js';

export type LockContents = {
  pid: number;
  acquiredAt: string;
};

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000; // 10 minutes

/**
 * A simple file-based lock guarding a state file for the duration of an apply/destroy/import.
 * A lock older than `staleAfterMs` is considered abandoned (e.g. the process that held it
 * crashed) and may be reclaimed by a subsequent acquire.
 */
export class StateLock {
  public constructor(
    private readonly lockFile: string,
    private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ) {}

  public async acquire(): Promise<void> {
    const existing = await this.readIfPresent();
    if (existing && !this.isStale(existing)) {
      throw new StateLockedError(
        `State is locked by process ${existing.pid} (acquired at ${existing.acquiredAt}). ` +
          'Another apply/destroy/import may be in progress. If that process crashed, the lock ' +
          'will be reclaimed automatically once it goes stale.'
      );
    }

    const contents: LockContents = { pid: process.pid, acquiredAt: new Date().toISOString() };
    if (existing) await unlink(this.lockFile);
    try {
      await writeFile(this.lockFile, JSON.stringify(contents), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new StateLockedError('Another process acquired the state lock.');
      throw error;
    }
  }

  public async release(): Promise<void> {
    await unlink(this.lockFile).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  private async readIfPresent(): Promise<LockContents | undefined> {
    try {
      const contents = await readFile(this.lockFile, 'utf8');
      return JSON.parse(contents) as LockContents;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private isStale(lock: LockContents): boolean {
    const age = Date.now() - new Date(lock.acquiredAt).getTime();
    if (age <= this.staleAfterMs) return false;
    try {
      process.kill(lock.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
}
