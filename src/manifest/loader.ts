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
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ManifestLoadError } from './errors.js';
import { Block, LoadedManifest, RawManifestFile } from './types.js';

function parseManifestFile(filePath: string, contents: string): RawManifestFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (e) {
    throw new ManifestLoadError(`${filePath}: not valid JSON (${(e as Error).message})`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new ManifestLoadError(`${filePath}: manifest must be a JSON object`);
  }

  const obj = parsed as Partial<RawManifestFile>;
  if (typeof obj.useCase !== 'string' || obj.useCase.length === 0) {
    throw new ManifestLoadError(`${filePath}: missing required top-level "useCase" string`);
  }
  if (typeof obj.dataSpace !== 'string' || obj.dataSpace.length === 0) {
    throw new ManifestLoadError(`${filePath}: missing required top-level "dataSpace" string`);
  }
  if (!Array.isArray(obj.resources)) {
    throw new ManifestLoadError(`${filePath}: missing required top-level "resources" array`);
  }

  return { useCase: obj.useCase, dataSpace: obj.dataSpace, resources: obj.resources };
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => join(dirPath, e.name))
    .sort();
}

/**
 * Loads a manifest from either a single JSON file or a directory of JSON files.
 * Every file in a directory must declare the same useCase/dataSpace (hard error otherwise),
 * and logical names must be unique across the whole merged set.
 */
export async function loadManifest(manifestPath: string): Promise<LoadedManifest> {
  const stats = await stat(manifestPath);
  const filePaths = stats.isDirectory() ? await listJsonFiles(manifestPath) : [manifestPath];

  if (filePaths.length === 0) {
    throw new ManifestLoadError(`${manifestPath}: directory contains no .json manifest files`);
  }

  const files = await Promise.all(
    filePaths.map(async (filePath) => ({
      filePath,
      manifest: parseManifestFile(filePath, await readFile(filePath, 'utf8')),
    }))
  );

  const [first, ...rest] = files;
  for (const file of rest) {
    if (file.manifest.useCase !== first.manifest.useCase) {
      throw new ManifestLoadError(
        `${file.filePath}: useCase "${file.manifest.useCase}" does not match "${first.manifest.useCase}" declared in ${first.filePath}`
      );
    }
    if (file.manifest.dataSpace !== first.manifest.dataSpace) {
      throw new ManifestLoadError(
        `${file.filePath}: dataSpace "${file.manifest.dataSpace}" does not match "${first.manifest.dataSpace}" declared in ${first.filePath}`
      );
    }
  }

  const blocks: Block[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    for (const block of file.manifest.resources) {
      const key = `${block.kind ?? 'resource'}:${block.type}.${block.name}`;
      const existing = seen.get(key);
      if (existing) {
        throw new ManifestLoadError(
          `Duplicate logical name "${block.type}.${block.name}" declared in both ${existing} and ${file.filePath}`
        );
      }
      seen.set(key, file.filePath);
      blocks.push(block);
    }
  }

  return { useCase: first.manifest.useCase, dataSpace: first.manifest.dataSpace, blocks };
}
