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
import { SegmentAdapter } from '../../src/adapters/segment.js';
import { IdentityResolutionRulesetAdapter } from '../../src/adapters/identity-resolution-ruleset.js';
import { CalculatedInsightAdapter } from '../../src/adapters/calculated-insight.js';
import { ActivationPlatformAdapter } from '../../src/adapters/activation-platform.js';
import { ActivationAdapter } from '../../src/adapters/activation.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('async job adapters (poll-by-status-field)', () => {
  it('Segment.waitForCompletion never calls actions/publish -- create/update alone trigger qualification -- and just polls segmentStatus', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/segments/seg-1', () => {
      getCalls += 1;
      // Confirmed live: create alone (no actions/publish at all) transitions segmentStatus
      // PROCESSING -> ACTIVE on its own.
      return {
        marketSegmentId: 'seg-1',
        apiName: 'high_risk',
        segmentStatus: getCalls === 1 ? 'PROCESSING' : 'ACTIVE',
      };
    });

    const result = await adapter.waitForCompletion({ client }, 'seg-1');
    expect(result).to.deep.equal({ marketSegmentId: 'seg-1', apiName: 'high_risk', segmentStatus: 'ACTIVE' });
    const publishCalls = client.calls.filter((c) => c.path === '/ssot/segments/seg-1/actions/publish');
    expect(publishCalls).to.have.lengthOf(0);
  });

  it('Segment.waitForCompletion returns immediately, with no poll, when already ACTIVE', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/segments/seg-1', () => {
      getCalls += 1;
      return { marketSegmentId: 'seg-1', apiName: 'high_risk', segmentStatus: 'ACTIVE' };
    });

    const result = await adapter.waitForCompletion({ client }, 'seg-1');

    expect(result).to.deep.equal({ marketSegmentId: 'seg-1', apiName: 'high_risk', segmentStatus: 'ACTIVE' });
    expect(getCalls).to.equal(1);
  });

  it('IdentityResolutionRuleset.waitForCompletion resolves once rulesetStatus: "PUBLISHED", without waiting on lastJobStatus', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new IdentityResolutionRulesetAdapter();
    client.on('POST', '/ssot/identity-resolutions/irr-1/actions/run-now', () => ({
      resultCode: 'SuccessfullySubmittedIdentityResolutionJobRunRequest',
    }));
    client.on('GET', '/ssot/identity-resolutions/irr-1', () => ({
      id: 'irr-1',
      rulesetStatus: 'PUBLISHED',
      // Per explicit product guidance: a long-running match job must never block apply --
      // rulesetStatus is this resource's own completion signal, lastJobStatus is not awaited.
      lastJobStatus: 'IN_PROGRESS',
      secondaryDmo: 'UnifiedAccount_DMO',
    }));

    const result = await adapter.waitForCompletion({ client }, 'irr-1');

    expect(result).to.deep.equal({
      rulesetStatus: 'PUBLISHED',
      lastJobStatus: 'IN_PROGRESS',
      secondaryDmo: 'UnifiedAccount_DMO',
    });
    const runNowCalls = client.calls.filter((c) => c.path === '/ssot/identity-resolutions/irr-1/actions/run-now');
    expect(runNowCalls).to.have.lengthOf(1);
  });

  it('IdentityResolutionRuleset.waitForCompletion waits for rulesetStatus: "PUBLISHED" before calling run-now', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new IdentityResolutionRulesetAdapter();
    // Confirmed live: a freshly created ruleset starts at rulesetStatus "NEW"/"PUBLISHING" and
    // calling run-now before it reaches "PUBLISHED" fails with "Try again when the ruleset's
    // status is Published." -- this simulates one still-publishing poll before it's ready.
    let getCallCount = 0;
    client.on('GET', '/ssot/identity-resolutions/irr-2', () => {
      getCallCount += 1;
      return {
        id: 'irr-2',
        rulesetStatus: getCallCount === 1 ? 'PUBLISHING' : 'PUBLISHED',
        lastJobStatus: 'Never Run',
      };
    });
    client.on('POST', '/ssot/identity-resolutions/irr-2/actions/run-now', () => ({
      resultCode: 'SuccessfullySubmittedIdentityResolutionJobRunRequest',
    }));

    const result = await adapter.waitForCompletion({ client }, 'irr-2');

    expect(result).to.deep.equal({ rulesetStatus: 'PUBLISHED', lastJobStatus: 'Never Run' });
    // run-now must not have been called while still PUBLISHING.
    const runNowCalls = client.calls.filter((c) => c.path === '/ssot/identity-resolutions/irr-2/actions/run-now');
    expect(runNowCalls).to.have.lengthOf(1);
  });

  it('CalculatedInsight.waitForCompletion never calls actions/run -- create/update alone trigger processing -- and just polls calculatedInsightStatus', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/calculated-insights/AssetHealthScore__cio', () => {
      getCalls += 1;
      // Confirmed live: a PATCH alone (no actions/run at all) transitions
      // calculatedInsightStatus ACTIVE -> PROCESSING -> ACTIVE on its own within a few seconds.
      return {
        apiName: 'AssetHealthScore__cio',
        calculatedInsightStatus: getCalls === 1 ? 'PROCESSING' : 'ACTIVE',
      };
    });

    const result = await adapter.waitForCompletion({ client }, 'AssetHealthScore__cio');
    // apiName comes back with the __cio suffix stripped in properties -- see
    // calculated-insight.test.ts for why (diffing against the manifest's unsuffixed value).
    expect(result).to.deep.equal({ apiName: 'AssetHealthScore', calculatedInsightStatus: 'ACTIVE' });
    const runCalls = client.calls.filter(
      (c) => c.path === '/ssot/calculated-insights/AssetHealthScore__cio/actions/run'
    );
    expect(runCalls).to.have.lengthOf(0);
  });

  it('CalculatedInsight.waitForCompletion returns immediately, with no poll, when already ACTIVE', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/calculated-insights/AssetHealthScore__cio', () => {
      getCalls += 1;
      return { apiName: 'AssetHealthScore__cio', calculatedInsightStatus: 'ACTIVE' };
    });

    const result = await adapter.waitForCompletion({ client }, 'AssetHealthScore__cio');

    expect(result).to.deep.equal({ apiName: 'AssetHealthScore', calculatedInsightStatus: 'ACTIVE' });
    expect(getCalls).to.equal(1);
  });

  it('ActivationPlatform.waitForCompletion POSTs actions/publish then polls status', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationPlatformAdapter();
    client.on('POST', '/ssot/activation-platforms/plat-1/actions/publish', () => ({}));
    client.on('GET', '/ssot/activation-platforms/plat-1', () => ({ id: 'plat-1', status: 'Active' }));

    const result = await adapter.waitForCompletion({ client }, 'plat-1');
    expect(result).to.deep.equal({ status: 'Active' });
  });

  it('Activation.waitForCompletion never calls actions/full-refresh -- create alone activates -- and just polls status', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/activations/act-1', () => {
      getCalls += 1;
      // Confirmed live: create alone (no actions/full-refresh at all) transitions status
      // PROCESSING -> ACTIVE on its own, often within seconds.
      return { id: 'act-1', status: getCalls === 1 ? 'PROCESSING' : 'ACTIVE' };
    });

    const result = await adapter.waitForCompletion({ client }, 'act-1');
    expect(result).to.deep.equal({ status: 'ACTIVE' });
    const refreshCalls = client.calls.filter((c) => c.path === '/ssot/activations/actions/act-1/full-refresh');
    expect(refreshCalls).to.have.lengthOf(0);
  });

  it('Activation.waitForCompletion returns immediately, with no poll, when already ACTIVE', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new ActivationAdapter();
    let getCalls = 0;
    client.on('GET', '/ssot/activations/act-1', () => {
      getCalls += 1;
      return { id: 'act-1', status: 'ACTIVE' };
    });

    const result = await adapter.waitForCompletion({ client }, 'act-1');

    expect(result).to.deep.equal({ status: 'ACTIVE' });
    expect(getCalls).to.equal(1);
  });

  it('a failure status value throws', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new SegmentAdapter();
    client.on('POST', '/ssot/segments/seg-1/actions/publish', () => ({}));
    client.on('GET', '/ssot/segments/seg-1', () => ({
      marketSegmentId: 'seg-1',
      apiName: 'high_risk',
      segmentStatus: 'ERROR',
    }));

    try {
      await adapter.waitForCompletion({ client }, 'seg-1');
      expect.fail('expected waitForCompletion to throw');
    } catch (e) {
      expect((e as Error).message).to.include('status=ERROR');
    }
  });
});
