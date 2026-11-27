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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { loadManifest } from '../../src/manifest/loader.js';
import { ManifestLoadError } from '../../src/manifest/errors.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(TEST_DIR, '..', 'fixtures', 'asset-maintenance.json');

describe('loadManifest', () => {
  it('loads a single manifest file', async () => {
    const manifest = await loadManifest(FIXTURE_PATH);
    expect(manifest.useCase).to.equal('asset-maintenance');
    expect(manifest.dataSpace).to.equal('default');
    expect(manifest.blocks).to.have.lengthOf(31);
  });

  describe('directory merge', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'data360-manifest-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('merges every .json file in the directory into one resource graph', async () => {
      await writeFile(
        join(dir, 'connections.json'),
        JSON.stringify({
          useCase: 'multi-file',
          dataSpace: 'default',
          resources: [{ kind: 'resource', type: 'Connection', name: 'conn_a', properties: {} }],
        })
      );
      await writeFile(
        join(dir, 'streams.json'),
        JSON.stringify({
          useCase: 'multi-file',
          dataSpace: 'default',
          resources: [
            {
              kind: 'resource',
              type: 'DataStream',
              name: 'stream_a',
              properties: { sourceConnection: '${Connection.conn_a.id}' },
            },
          ],
        })
      );

      const manifest = await loadManifest(dir);
      expect(manifest.blocks).to.have.lengthOf(2);
    });

    it('fails with a clear error on mismatched dataSpace across files', async () => {
      await writeFile(join(dir, 'a.json'), JSON.stringify({ useCase: 'uc', dataSpace: 'default', resources: [] }));
      await writeFile(join(dir, 'b.json'), JSON.stringify({ useCase: 'uc', dataSpace: 'other', resources: [] }));

      try {
        await loadManifest(dir);
        expect.fail('expected loadManifest to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ManifestLoadError);
        expect((e as Error).message).to.include('dataSpace');
      }
    });

    it('fails with a clear error on mismatched useCase across files', async () => {
      await writeFile(join(dir, 'a.json'), JSON.stringify({ useCase: 'uc-one', dataSpace: 'default', resources: [] }));
      await writeFile(join(dir, 'b.json'), JSON.stringify({ useCase: 'uc-two', dataSpace: 'default', resources: [] }));

      try {
        await loadManifest(dir);
        expect.fail('expected loadManifest to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ManifestLoadError);
        expect((e as Error).message).to.include('useCase');
      }
    });

    it('fails with a clear error when a file in the directory is not valid JSON', async () => {
      await writeFile(join(dir, 'a.json'), JSON.stringify({ useCase: 'uc', dataSpace: 'default', resources: [] }));
      await writeFile(join(dir, 'b.json'), '{ this is not valid json');

      try {
        await loadManifest(dir);
        expect.fail('expected loadManifest to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ManifestLoadError);
        expect((e as Error).message).to.include('not valid JSON');
      }
    });

    it('fails with a clear error on an empty directory', async () => {
      try {
        await loadManifest(dir);
        expect.fail('expected loadManifest to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ManifestLoadError);
        expect((e as Error).message).to.include('no .json manifest files');
      }
    });

    it('ignores non-.json files in the directory', async () => {
      await writeFile(
        join(dir, 'connections.json'),
        JSON.stringify({
          useCase: 'uc',
          dataSpace: 'default',
          resources: [{ kind: 'resource', type: 'Connection', name: 'conn_a', properties: {} }],
        })
      );
      await writeFile(join(dir, 'README.md'), '# not a manifest');

      const manifest = await loadManifest(dir);
      expect(manifest.blocks).to.have.lengthOf(1);
    });

    it('fails with a clear error on duplicate logical names across files', async () => {
      await writeFile(
        join(dir, 'a.json'),
        JSON.stringify({
          useCase: 'uc',
          dataSpace: 'default',
          resources: [{ kind: 'resource', type: 'Connection', name: 'dup', properties: {} }],
        })
      );
      await writeFile(
        join(dir, 'b.json'),
        JSON.stringify({
          useCase: 'uc',
          dataSpace: 'default',
          resources: [{ kind: 'resource', type: 'Connection', name: 'dup', properties: {} }],
        })
      );

      try {
        await loadManifest(dir);
        expect.fail('expected loadManifest to throw');
      } catch (e) {
        expect(e).to.be.instanceOf(ManifestLoadError);
        expect((e as Error).message).to.include('Duplicate logical name');
      }
    });
  });
});
