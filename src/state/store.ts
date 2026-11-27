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
import { readFile, writeFile, copyFile, mkdir, unlink, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StatePaths } from './paths.js';
import { StateFile, OrgFingerprint, emptyState, STATE_FORMAT_VERSION } from './types.js';
import { OrgFingerprintMismatchError, StateError } from './errors.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function parseStateFile(contents: string, source: string): StateFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    throw new StateError(`${source}: not valid JSON (${(e as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new StateError(`${source}: state file must be a JSON object`);
  }
  const obj = parsed as Partial<StateFile>;
  if (obj.formatVersion !== STATE_FORMAT_VERSION && obj.formatVersion !== '1.0') {
    throw new StateError(`${source}: unsupported state formatVersion "${String(obj.formatVersion)}"`);
  }
  if (
    !obj.orgFingerprint ||
    typeof obj.serial !== 'number' ||
    typeof obj.lineage !== 'string' ||
    !Array.isArray(obj.resources)
  ) {
    throw new StateError(`${source}: state file is missing required fields`);
  }
  return { ...obj, formatVersion: STATE_FORMAT_VERSION } as StateFile;
}

/**
 * Reads, writes, and initializes the local state file described in Section 6: a visible
 * state file plus a rotated `.backup`, keyed by (org, Data Space) rather than by manifest.
 */
export class StateStore {
  public constructor(public readonly paths: StatePaths) {}

  public async exists(): Promise<boolean> {
    return pathExists(this.paths.stateFile);
  }

  /** Creates a brand-new, empty state file with a freshly generated lineage. Fails if one already exists. */
  public async init(orgFingerprint: OrgFingerprint): Promise<StateFile> {
    if (await this.exists()) {
      throw new StateError(`State already initialized at ${this.paths.stateFile}`);
    }
    await mkdir(this.paths.plansDir, { recursive: true });
    const state = emptyState(orgFingerprint, randomUUID());
    await writeFile(this.paths.stateFile, JSON.stringify(state, null, 2));
    return state;
  }

  /**
   * Reads the current state, falling back to `.backup` if the primary file is corrupted.
   * Verifies the live org's fingerprint matches the one recorded in state.
   */
  public async read(liveFingerprint: OrgFingerprint): Promise<StateFile> {
    const state = await this.readRaw();
    this.assertFingerprintMatches(state, liveFingerprint);
    return state;
  }

  /**
   * Writes a new state, incrementing `serial` and rotating the previous file to `.backup` first.
   */
  public async write(state: StateFile): Promise<StateFile> {
    const next: StateFile = { ...state, serial: state.serial + 1 };

    if (await pathExists(this.paths.stateFile)) {
      await copyFile(this.paths.stateFile, this.paths.backupFile);
    }

    const temporary = `${this.paths.stateFile}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(next, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.paths.stateFile);
    return next;
  }

  public async removeAll(): Promise<void> {
    await Promise.all(
      [this.paths.stateFile, this.paths.backupFile, this.paths.lockFile].map((f) =>
        unlink(f).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        })
      )
    );
  }

  private async readRaw(): Promise<StateFile> {
    try {
      const contents = await readFile(this.paths.stateFile, 'utf8');
      return parseStateFile(contents, this.paths.stateFile);
    } catch (primaryError) {
      if ((primaryError as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StateError(`No state file found at ${this.paths.stateFile}. Run "data360 init" first.`);
      }
      try {
        const backupContents = await readFile(this.paths.backupFile, 'utf8');
        return parseStateFile(backupContents, this.paths.backupFile);
      } catch {
        throw primaryError;
      }
    }
  }

  private assertFingerprintMatches(state: StateFile, live: OrgFingerprint): void {
    if (state.orgFingerprint.orgId !== live.orgId || state.orgFingerprint.dataSpace !== live.dataSpace) {
      throw new OrgFingerprintMismatchError(
        `State at ${this.paths.stateFile} was recorded for org ${state.orgFingerprint.orgId} ` +
          `(Data Space "${state.orgFingerprint.dataSpace}"), but the authenticated org is ` +
          `${live.orgId} (Data Space "${live.dataSpace}"). Refusing to continue.`
      );
    }
  }
}
