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
export type BackoffPolicy = {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
  maxAttempts: number;
};

/**
 * The general transient-failure retry policy from Section 13 (HTTP 429/5xx, etc).
 *
 * Deliberately short: 3 attempts, 15s request timeout each -- worst case ~45s, not minutes.
 * Confirmed live: an earlier, more patient policy (8 attempts x 60s timeout = up to 8.6 minutes
 * for a single request) made a genuinely dead connection's retry sequence indistinguishable from
 * `apply` hanging outright -- no progress event fires while a single request is mid-retry, so a
 * user watching the terminal sees total silence for the whole worst-case duration. A short,
 * bounded policy fails fast enough that the resulting error (and the next `apply` invocation,
 * which gets a brand-new connection) is a far better recovery path than waiting out a long retry
 * on a connection that's actually dead.
 */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
  initialDelayMs: 500,
  maxDelayMs: 5_000,
  factor: 2,
  maxAttempts: 3,
};

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries `fn` with exponential backoff up to `policy.maxAttempts` attempts before treating the
 * last failure as a hard failure. `isRetryable` lets callers exclude non-transient errors
 * (e.g. a 4xx that isn't a rate limit) from being retried at all. `onRetry`, when supplied, is
 * called with the attempt number and the error right before each retry sleep -- so a caller can
 * surface "a request failed, retrying..." instead of appearing to hang while a request is
 * silently being retried.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
  isRetryable: (error: unknown) => boolean = () => true,
  onRetry?: (attempt: number, error: unknown) => void,
  sleep: Sleep = defaultSleep
): Promise<T> {
  let delay = policy.initialDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- retries are inherently sequential.
      return await fn();
    } catch (e) {
      lastError = e;
      if (attempt === policy.maxAttempts || !isRetryable(e)) {
        throw e;
      }
      onRetry?.(attempt, e);
      // eslint-disable-next-line no-await-in-loop -- waiting out the backoff delay before the next attempt.
      await sleep(delay);
      delay = Math.min(delay * policy.factor, policy.maxDelayMs);
    }
  }

  throw lastError;
}
