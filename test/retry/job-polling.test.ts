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
import { waitForJobCompletion, JobPollingPolicy, JobTimeoutError } from '../../src/retry/job-polling.js';

const FAST_POLICY: JobPollingPolicy = { intervalMs: 1, timeoutMs: 50 };

describe('waitForJobCompletion', () => {
  it('returns the result once polling reports a terminal success', async () => {
    let calls = 0;
    const result = await waitForJobCompletion<{ ok: boolean }>(
      async () => {
        calls++;
        if (calls < 3) return { terminal: false };
        return { terminal: true, result: { ok: true } };
      },
      FAST_POLICY,
      undefined,
      async () => {}
    );
    expect(result).to.deep.equal({ ok: true });
    expect(calls).to.equal(3);
  });

  it('calls onPoll with each non-terminal status observed, at a fixed interval (no backoff)', async () => {
    let calls = 0;
    const observedStatuses: Array<string | undefined> = [];
    const result = await waitForJobCompletion<{ ok: boolean }>(
      async () => {
        calls++;
        if (calls < 3) return { terminal: false, status: `IN_PROGRESS_${calls}` };
        return { terminal: true, result: { ok: true } };
      },
      FAST_POLICY,
      (status) => observedStatuses.push(status),
      async () => {}
    );
    expect(result).to.deep.equal({ ok: true });
    expect(observedStatuses).to.deep.equal(['IN_PROGRESS_1', 'IN_PROGRESS_2']);
  });

  it('throws when the job reports a terminal failure', async () => {
    try {
      await waitForJobCompletion(
        async () => ({ terminal: true, failed: true, reason: 'ingestion error' }),
        FAST_POLICY,
        undefined,
        async () => {}
      );
      expect.fail('expected waitForJobCompletion to throw');
    } catch (e) {
      expect((e as Error).message).to.include('ingestion error');
    }
  });

  it('throws JobTimeoutError when the overall timeout elapses without a terminal state', async () => {
    let simulatedNow = 0;
    try {
      await waitForJobCompletion(
        async () => ({ terminal: false }),
        FAST_POLICY,
        undefined,
        async () => {
          simulatedNow += 100;
        },
        () => simulatedNow
      );
      expect.fail('expected waitForJobCompletion to throw');
    } catch (e) {
      expect(e).to.be.instanceOf(JobTimeoutError);
    }
  });
});
