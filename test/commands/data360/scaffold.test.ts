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
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Org } from '@salesforce/core';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import Data360Scaffold from '../../../src/commands/data360/scaffold.js';
describe('data360 scaffold command sources', () => {
  const $$ = new TestContext();
  let directory: string;
  beforeEach(async () => {
    stubSfCommandUx($$.SANDBOX);
    directory = await mkdtemp(join(tmpdir(), 'scaffold-cli-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    $$.restore();
  });
  it('offline never calls Org.create, rejects source conflicts and needs no auth', async () => {
    const auth = $$.SANDBOX.stub(Org, 'create').throws(new Error('Offline must never authenticate'));
    await mkdir(join(directory, 'Connections'));
    await writeFile(
      join(directory, 'Connections', 'connections.json'),
      JSON.stringify({ connections: [{ id: 'source', name: 'source', label: 'Source', connectorType: 'IngestApi' }] })
    );
    const args = [
      '--from-discovery',
      directory,
      '--select',
      'Connection:source',
      '--use-case',
      'existing',
      '--out',
      join(directory, 'generated.json'),
    ];
    const result = await Data360Scaffold.run(args);
    expect(result.manifestPath).to.equal(join(directory, 'generated.json'));
    expect(auth.callCount).to.equal(0);
    let blocked = false;
    try {
      await Data360Scaffold.run([...args, '-o', 'unreachable-org']);
    } catch {
      blocked = true;
    }
    expect(blocked).to.equal(true);
    expect(auth.callCount).to.equal(0);
  });
  it('live uses GET only and leaves state/journals untouched', async () => {
    const org = new MockTestOrgData();
    await $$.stubAuths(org);
    const methods: string[] = [];
    $$.fakeConnectionRequest = async (request) => {
      const details = request as { method?: string; url?: string };
      methods.push(details.method ?? 'GET');
      if (details.url?.endsWith('/ssot/connections?connectorType=IngestApi'))
        return { connections: [{ id: 'source', name: 'source', label: 'Source', connectorType: 'IngestApi' }] };
      return {};
    };
    const before = await readdir(directory);
    const result = await Data360Scaffold.run([
      '-o',
      org.username,
      '--select',
      'Connection:source',
      '--use-case',
      'existing',
      '--out',
      join(directory, 'generated.json'),
    ]);
    expect(result.report.source.mode).to.equal('live');
    expect(methods.length).to.be.greaterThan(0);
    expect(methods.every((m) => m === 'GET')).to.equal(true);
    expect((await readdir(directory)).sort()).to.deep.equal(
      [...before, 'generated.json', 'generated.json.report.json'].sort()
    );
  });
});
