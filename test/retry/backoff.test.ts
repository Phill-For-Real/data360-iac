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
import { retryWithBackoff, BackoffPolicy } from '../../src/retry/backoff.js';

const FAST_POLICY: BackoffPolicy = { initialDelayMs: 1, maxDelayMs: 2, factor: 2, maxAttempts: 3 };

describe('retryWithBackoff', () => {
  it('returns the result on the first successful attempt', async () => {
    const result = await retryWithBackoff(async () => 42, FAST_POLICY);
    expect(result).to.equal(42);
  });

  it('retries transient failures up to maxAttempts before giving up', async () => {
    let calls = 0;
    try {
      await retryWithBackoff(
        async () => {
          calls++;
          throw new Error('transient');
        },
        FAST_POLICY,
        () => true,
        undefined,
        async () => {}
      );
      expect.fail('expected retryWithBackoff to throw');
    } catch (e) {
      expect((e as Error).message).to.equal('transient');
    }
    expect(calls).to.equal(FAST_POLICY.maxAttempts);
  });

  it('succeeds after a transient failure followed by success', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 2) throw new Error('transient');
        return 'ok';
      },
      FAST_POLICY,
      () => true,
      undefined,
      async () => {}
    );
    expect(result).to.equal('ok');
    expect(calls).to.equal(2);
  });

  it('does not retry an error classified as non-retryable', async () => {
    let calls = 0;
    try {
      await retryWithBackoff(
        async () => {
          calls++;
          throw new Error('not retryable');
        },
        FAST_POLICY,
        () => false,
        undefined,
        async () => {}
      );
      expect.fail('expected retryWithBackoff to throw');
    } catch (e) {
      expect((e as Error).message).to.equal('not retryable');
    }
    expect(calls).to.equal(1);
  });

  it('calls onRetry with the attempt number and error before each retry sleep', async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; message: string }> = [];
    await retryWithBackoff(
      async () => {
        calls++;
        if (calls < 3) throw new Error(`transient-${calls}`);
        return 'ok';
      },
      FAST_POLICY,
      () => true,
      (attempt, error) => retries.push({ attempt, message: (error as Error).message }),
      async () => {}
    );
    expect(retries).to.deep.equal([
      { attempt: 1, message: 'transient-1' },
      { attempt: 2, message: 'transient-2' },
    ]);
  });
});
