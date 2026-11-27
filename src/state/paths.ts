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

/**
 * Local file/folder layout per Section 6.1: a `.data360/` tool-internal config directory, plus
 * a visible `data360.<org-alias>.<data-space>.state.json` state file, a rotated `.backup`
 * copy of the previous state, and a `.lock` file present only during an in-flight apply.
 */
export class StatePaths {
  public readonly configDir: string;
  public readonly plansDir: string;
  public readonly journalFile: string;
  public readonly stateFile: string;
  public readonly backupFile: string;
  public readonly lockFile: string;

  public constructor(public readonly projectDir: string, orgAlias: string, dataSpace: string) {
    const baseName = `data360.${orgAlias}.${dataSpace}.state.json`;
    this.configDir = join(projectDir, '.data360');
    this.plansDir = join(this.configDir, 'plans');
    this.journalFile = join(this.configDir, 'operations', `${baseName}.journal.json`);
    this.stateFile = join(projectDir, baseName);
    this.backupFile = join(projectDir, `${baseName}.backup`);
    this.lockFile = join(projectDir, `${baseName}.lock`);
  }
}
