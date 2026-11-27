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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { OperationJournal, JournalClient } from '../../src/state/journal.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { emptyState } from '../../src/state/types.js';
describe('durable mutation journal', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'data360-journal-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const state = (): ReturnType<typeof emptyState> =>
    emptyState({ orgId: 'test-org', instanceUrl: '', targetOrgAlias: 'test', dataSpace: 'default' }, 'test-lineage');
  it('does not replay a committed write whose response was lost, including after restart', async () => {
    const remote = new FakeConnectRestClient();
    let committed = false;
    remote.on('POST', '/ssot/identity-resolutions', () => {
      committed = true;
      throw new Error('fetch failed');
    });
    const journal = new OperationJournal(join(dir, 'journal.json'), state());
    const client = new JournalClient(remote, journal, {
      key: 'IdentityResolutionRuleset.test',
      type: 'IdentityResolutionRuleset',
      intent: { label: 'test' },
      planId: 'p',
      operation: 'create',
    });
    try {
      await client.request({ method: 'POST', path: '/ssot/identity-resolutions', body: { label: 'test' } });
    } catch {
      /* expected */
    }
    expect(committed).to.equal(true);
    expect((await journal.pending())[0].phase).to.equal('uncertain');
    const restarted = new OperationJournal(join(dir, 'journal.json'), state());
    try {
      await restarted.assertReady();
      expect.fail('must pause');
    } catch (e) {
      expect((e as Error).message).to.include('recovery');
    }
    expect(remote.calls.filter((r) => r.method === 'POST')).to.have.length(1);
  });
  it('persists dispatch before transport and never stores the request body or raw error', async () => {
    const remote = new FakeConnectRestClient();
    const journal = new OperationJournal(join(dir, 'journal.json'), state());
    remote.on('PUT', '/ssot/connections/test', async () => {
      expect((await journal.pending())[0].phase).to.equal('dispatching');
      throw new Error('resolved-private-value');
    });
    const client = new JournalClient(remote, journal, {
      key: 'Connection.test',
      type: 'Connection',
      intent: { credentials: { $secret: { source: 'env', key: 'INPUT' } } },
      planId: 'p',
      operation: 'update',
      remoteId: 'test',
    });
    try {
      await client.request({
        method: 'PUT',
        path: '/ssot/connections/test',
        body: { credentials: 'resolved-private-value' },
      });
    } catch {
      /* expected */
    }
    const contents = await readFile(join(dir, 'journal.json'), 'utf8');
    expect(contents).not.to.include('resolved-private-value');
    expect(contents).to.include('INPUT');
  });
  it('sends no write when intent persistence fails', async () => {
    const remote = new FakeConnectRestClient();
    const journal = new OperationJournal('/dev/null/journal.json', state());
    const client = new JournalClient(remote, journal, {
      key: 'Connection.test',
      type: 'Connection',
      intent: {},
      planId: 'p',
      operation: 'create',
    });
    try {
      await client.request({ method: 'POST', path: '/ssot/connections', body: {} });
    } catch {
      /* expected */
    }
    expect(remote.calls).to.have.length(0);
  });
  it('pauses later queued mutations as soon as an earlier result becomes uncertain', async () => {
    const remote = new FakeConnectRestClient();
    remote.on('POST', '/ssot/connections', () => {
      throw new Error('fetch failed');
    });
    const journal = new OperationJournal(join(dir, 'journal.json'), state());
    const first = new JournalClient(remote, journal, {
      key: 'Connection.first',
      type: 'Connection',
      intent: {},
      planId: 'p',
      operation: 'create',
    });
    try {
      await first.request({ method: 'POST', path: '/ssot/connections', body: {} });
    } catch {
      /* expected */
    }
    const second = new JournalClient(remote, journal, {
      key: 'Connection.second',
      type: 'Connection',
      intent: {},
      planId: 'p',
      operation: 'create',
    });
    try {
      await second.request({ method: 'POST', path: '/ssot/connections', body: {} });
    } catch {
      /* blocked */
    }
    expect(remote.calls).to.have.length(1);
  });
});
