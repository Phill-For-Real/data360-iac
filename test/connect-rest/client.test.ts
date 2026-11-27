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
import sinon from 'sinon';
import { Connection } from '@salesforce/core';
import { FakeConnectRestClient, RealConnectRestClient, RequestTimeoutError } from '../../src/connect-rest/client.js';

describe('RealConnectRestClient', () => {
  it('retries a bare network-level failure (e.g. "fetch failed") and succeeds once the transient error clears', async () => {
    let calls = 0;
    const fakeConnection = {
      request: async () => {
        calls += 1;
        if (calls < 2) throw new Error('fetch failed');
        return { ok: true };
      },
    } as unknown as Connection;
    const client = new RealConnectRestClient(fakeConnection);

    const result = await client.request({ method: 'GET', path: '/ssot/calculated-insights/X__cio' });

    expect(result).to.deep.equal({ ok: true });
    expect(calls).to.equal(2);
  });

  it('does not retry a non-transient error (e.g. a validation 4xx with no status/message match)', async () => {
    let calls = 0;
    const fakeConnection = {
      request: async () => {
        calls += 1;
        throw new Error('INVALID_FIELD: some validation problem');
      },
    } as unknown as Connection;
    const client = new RealConnectRestClient(fakeConnection);

    try {
      await client.request({ method: 'POST', path: '/ssot/data-streams' });
      expect.fail('expected request to throw');
    } catch (e) {
      expect((e as Error).message).to.equal('INVALID_FIELD: some validation problem');
    }
    expect(calls).to.equal(1);
  });
});

describe('Separate read and mutation deadlines', () => {
  it('allows one write to finish after the read deadline without replaying it', async () => {
    const clock = sinon.useFakeTimers();
    let complete: ((value: unknown) => void) | undefined;
    let writes = 0;
    let settled = false;
    let caught: unknown;
    try {
      const connection = {
        request: async () => {
          writes++;
          return new Promise((resolve) => {
            complete = resolve;
          });
        },
      } as unknown as Connection;
      const client = new RealConnectRestClient(connection, 10, undefined, undefined, 60);
      const pending = client.request({ method: 'DELETE', path: '/ssot/data-model-object-mappings/map-1' }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          caught = error;
          settled = true;
        }
      );
      await clock.tickAsync(15);
      expect(settled).to.equal(false);
      expect(writes).to.equal(1);
      complete?.({ ok: true });
      expect(await pending).to.deep.equal({ ok: true });
      expect(caught).to.equal(undefined);
    } finally {
      clock.restore();
    }
  });
});

describe('Mutation replay protection', () => {
  for (const method of ['DELETE', 'PUT', 'PATCH'] as const) {
    it(`does not replay ${method} after a transport failure`, async () => {
      let writes = 0;
      const connection = {
        request: async () => {
          writes++;
          throw new Error('fetch failed');
        },
      } as unknown as Connection;
      const client = new RealConnectRestClient(connection, 10, {
        initialDelayMs: 0,
        maxDelayMs: 0,
        factor: 1,
        maxAttempts: 3,
      });
      try {
        await client.request({ method, path: '/ssot/activation-targets/target-1' });
      } catch {
        /* expected */
      }
      expect(writes).to.equal(1);
    });
  }
});

describe('RealConnectRestClient timeout', () => {
  it('does not replay a POST whose server-side write completed before its response timed out', async () => {
    let writes = 0;
    let retries = 0;
    const fakeConnection = {
      request: async () => {
        writes += 1;
        return new Promise(() => {});
      },
    } as unknown as Connection;
    const client = new RealConnectRestClient(fakeConnection, 10, undefined, () => {
      retries += 1;
    });

    try {
      await client.request({ method: 'POST', path: '/ssot/data-streams', body: { name: 'vehicle_stream' } });
      expect.fail('expected request to throw');
    } catch (error) {
      expect(error).to.be.instanceOf(RequestTimeoutError);
    }
    expect(writes).to.equal(1);
    expect(retries).to.equal(0);
  });

  for (const error of [new Error('fetch failed'), Object.assign(new Error('Internal error'), { statusCode: 500 })]) {
    it(`does not replay a POST after ${error.message}`, async () => {
      let writes = 0;
      const fakeConnection = {
        request: async () => {
          writes += 1;
          throw error;
        },
      } as unknown as Connection;
      const client = new RealConnectRestClient(fakeConnection);
      try {
        await client.request({ method: 'POST', path: '/ssot/data-streams' });
        expect.fail('expected request to throw');
      } catch (caught) {
        expect(caught).to.equal(error);
      }
      expect(writes).to.equal(1);
    });
  }

  it('retries a request that never settles (hangs) and succeeds once a later attempt resolves', async () => {
    let calls = 0;
    const fakeConnection = {
      request: async () => {
        calls += 1;
        if (calls === 1) {
          // A hung connection.request() -- confirmed live, repeatedly: neither resolves nor
          // rejects. Simulated here with a promise that never settles.
          return new Promise(() => {});
        }
        return { ok: true };
      },
    } as unknown as Connection;
    // A short timeout so the test doesn't wait out the real 60s default.
    const client = new RealConnectRestClient(fakeConnection, 50);

    const result = await client.request({ method: 'GET', path: '/ssot/calculated-insights/X__cio' });

    expect(result).to.deep.equal({ ok: true });
    expect(calls).to.equal(2);
  });

  it('throws RequestTimeoutError if every attempt hangs past maxAttempts', async () => {
    const fakeConnection = {
      request: async () => new Promise(() => {}),
    } as unknown as Connection;
    const client = new RealConnectRestClient(fakeConnection, 10, {
      initialDelayMs: 1,
      maxDelayMs: 2,
      factor: 2,
      maxAttempts: 2,
    });

    try {
      await client.request({ method: 'GET', path: '/ssot/calculated-insights/X__cio' });
      expect.fail('expected request to throw');
    } catch (e) {
      expect(e).to.be.instanceOf(RequestTimeoutError);
    }
  });
});

describe('FakeConnectRestClient', () => {
  it('routes a request to the handler registered for its method and path', async () => {
    const client = new FakeConnectRestClient();
    client.on('GET', '/some/path', () => ({ ok: true }));

    const result = await client.request({ method: 'GET', path: '/some/path' });

    expect(result).to.deep.equal({ ok: true });
  });

  it('records every call it receives', async () => {
    const client = new FakeConnectRestClient();
    client.on('POST', '/some/path', () => ({}));

    await client.request({ method: 'POST', path: '/some/path', body: { a: 1 } });

    expect(client.calls).to.deep.equal([{ method: 'POST', path: '/some/path', body: { a: 1 } }]);
  });

  it('throws when no handler is registered for the request', async () => {
    const client = new FakeConnectRestClient();

    try {
      await client.request({ method: 'GET', path: '/unregistered' });
      expect.fail('expected request to throw');
    } catch (e) {
      expect((e as Error).message).to.include('no handler registered');
    }
  });
});
