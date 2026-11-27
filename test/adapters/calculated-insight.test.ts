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
import { CalculatedInsightAdapter } from '../../src/adapters/calculated-insight.js';
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';

describe('CalculatedInsightAdapter', () => {
  it('normalizes publishScheduleInterval back to canonical case on lookup() (server echoes it uppercased)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights', () => ({
      collection: {
        items: [{ apiName: 'AssetHealthScore__cio', publishScheduleInterval: 'SIX' }],
      },
    }));

    const result = await adapter.lookup({ client }, { apiName: 'AssetHealthScore__cio' });

    expect(result?.properties.publishScheduleInterval).to.equal('Six');
  });

  it('lookup() matches a manifest-declared unsuffixed apiName against the live, __cio-suffixed one', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights', () => ({
      collection: {
        items: [{ apiName: 'VehicleHealthScore__cio', publishScheduleInterval: 'SIX' }],
      },
    }));

    // Confirmed live: the manifest's apiName never carries the suffix, but the live item's own
    // apiName always does -- an exact-only comparison would never adopt it.
    const result = await adapter.lookup({ client }, { apiName: 'VehicleHealthScore' });

    expect(result?.apiName).to.equal('VehicleHealthScore__cio');
  });

  it("strips the __cio suffix from properties.apiName so the diff matches the manifest's unsuffixed value", async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights', () => ({
      collection: {
        items: [{ apiName: 'VehicleHealthScore__cio' }],
      },
    }));

    // apiName is 'replace'-classified -- comparing the manifest's unsuffixed "VehicleHealthScore"
    // against properties.apiName must see no change, or every plan forces an adopt-update
    // (and its full create/run/wait cycle) instead of a clean adopt.
    const result = await adapter.lookup({ client }, { apiName: 'VehicleHealthScore' });

    expect(result?.apiName).to.equal('VehicleHealthScore__cio');
    expect(result?.properties.apiName).to.equal('VehicleHealthScore');
  });

  it('update() strips apiName/definitionType/dataSpaceName -- the real PATCH rejects them even unchanged', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('PATCH', '/ssot/calculated-insights/VehicleHealthScore__cio', (req) => ({
      ...(req.body as Record<string, unknown>),
      apiName: 'VehicleHealthScore__cio',
    }));

    await adapter.update({ client }, 'VehicleHealthScore__cio', {
      apiName: 'VehicleHealthScore',
      definitionType: 'CALCULATED_METRIC',
      dataSpaceName: 'default',
      displayName: 'Vehicle Health Score',
      expression: 'SELECT 1',
    });

    const patchCall = client.calls.find(
      (c) => c.method === 'PATCH' && c.path === '/ssot/calculated-insights/VehicleHealthScore__cio'
    );
    expect(patchCall?.body).to.deep.equal({
      displayName: 'Vehicle Health Score',
      expression: 'SELECT 1',
    });
  });

  it('unescapes HTML entities in expression on read() (the real API HTML-escapes stored SQL)', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights/VehicleHealthScore__cio', () => ({
      apiName: 'VehicleHealthScore__cio',
      expression:
        'SELECT x FROM y WHERE a = &#39;Fault&#39; AND b &lt; 5 AND c &gt; 1 AND d = &quot;q&quot; AND e &amp; f',
    }));

    const result = await adapter.read({ client }, 'VehicleHealthScore__cio');

    expect(result?.properties.expression).to.equal(
      'SELECT x FROM y WHERE a = \'Fault\' AND b < 5 AND c > 1 AND d = "q" AND e & f'
    );
  });

  it('leaves an expression with no HTML entities untouched', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights/VehicleHealthScore__cio', () => ({
      apiName: 'VehicleHealthScore__cio',
      expression: 'SELECT COUNT(*) FROM ssot__Account__dlm',
    }));

    const result = await adapter.read({ client }, 'VehicleHealthScore__cio');

    expect(result?.properties.expression).to.equal('SELECT COUNT(*) FROM ssot__Account__dlm');
  });

  it('normalizes publishScheduleInterval back to canonical case on read()', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights/AssetHealthScore__cio', () => ({
      apiName: 'AssetHealthScore__cio',
      publishScheduleInterval: 'TWENTYFOUR',
    }));

    const result = await adapter.read({ client }, 'AssetHealthScore__cio');

    expect(result?.properties.publishScheduleInterval).to.equal('TwentyFour');
  });

  it('leaves an already-canonical-case or unrecognized publishScheduleInterval value untouched', async () => {
    const client = new FakeConnectRestClient();
    const adapter = new CalculatedInsightAdapter();
    client.on('GET', '/ssot/calculated-insights/AssetHealthScore__cio', () => ({
      apiName: 'AssetHealthScore__cio',
      publishScheduleInterval: 'SomeUnknownValue',
    }));

    const result = await adapter.read({ client }, 'AssetHealthScore__cio');

    expect(result?.properties.publishScheduleInterval).to.equal('SomeUnknownValue');
  });
});
