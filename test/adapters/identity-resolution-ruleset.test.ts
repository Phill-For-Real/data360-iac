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
import { expect } from 'chai';
import { IdentityResolutionRulesetAdapter } from '../../src/adapters/identity-resolution-ruleset.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('IdentityResolutionRulesetAdapter', () => {
  it('lookup() matches on label -- this resource has no apiName/name', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new IdentityResolutionRulesetAdapter();
    client.on('GET', '/ssot/identity-resolutions', () => ({
      identityResolutions: [{ id: 'irr-1', label: 'Account Identity Resolution', rulesetStatus: 'PUBLISHED' }],
    }));

    const result = await adapter.lookup({ client }, { label: 'Account Identity Resolution' });

    expect(result?.id).to.equal('irr-1');
  });

  it('lookup() does not match a ruleset with a different label', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new IdentityResolutionRulesetAdapter();
    client.on('GET', '/ssot/identity-resolutions', () => ({
      identityResolutions: [{ id: 'irr-1', label: 'Some Other Ruleset', rulesetStatus: 'PUBLISHED' }],
    }));

    const result = await adapter.lookup({ client }, { label: 'Account Identity Resolution' });

    expect(result).to.be.undefined;
  });

  it('update() strips configurationType and rulesetId -- the real PATCH rejects both even unchanged', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new IdentityResolutionRulesetAdapter();
    client.on('PATCH', '/ssot/identity-resolutions/irr-1', (req) => ({
      ...(req.body as Record<string, unknown>),
      id: 'irr-1',
    }));

    await adapter.update({ client }, 'irr-1', {
      configurationType: 'Account',
      rulesetId: '',
      label: 'Account Identity Resolution',
      description: 'Resolves duplicate accounts',
    });

    const patchCall = client.calls.find((c) => c.method === 'PATCH' && c.path === '/ssot/identity-resolutions/irr-1');
    expect(patchCall?.body).to.deep.equal({
      label: 'Account Identity Resolution',
      description: 'Resolves duplicate accounts',
    });
  });
  for (const mode of ['absent', 'permission', 'wrong-id', 'wrong-code', 'deleting']) {
    it(`observes deletion using scoped provider evidence: ${mode}`, async () => {
      const client = new FakeConnectRestClient();
      client.on('GET', '/ssot/identity-resolutions/ruleset-1', () => {
        if (mode === 'deleting') return { id: 'ruleset-1', rulesetStatus: 'DELETING' };
        throw Object.assign(
          new Error(`Identity Resolution not found: ${mode === 'wrong-id' ? 'other-id' : 'ruleset-1'}`),
          {
            name: mode === 'wrong-code' ? 'UNKNOWN_ERROR' : 'ITEM_NOT_FOUND',
            errorCode: mode === 'wrong-code' ? 'UNKNOWN_ERROR' : 'ITEM_NOT_FOUND',
            ...(mode === 'permission' ? { statusCode: 403 } : {}),
          }
        );
      });
      const observation = await new IdentityResolutionRulesetAdapter().observeDeletion({ client }, 'ruleset-1');
      expect(observation.outcome).to.equal(mode === 'absent' ? 'absent' : mode === 'deleting' ? 'deleting' : 'unknown');
      expect(client.calls.every((request) => request.method === 'GET')).to.equal(true);
    });
  }
});
