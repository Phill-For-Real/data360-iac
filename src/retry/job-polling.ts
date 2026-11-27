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
export type JobPollingPolicy = {
  intervalMs: number;
  timeoutMs: number;
};

/**
 * The job-polling policy from Section 13: distinct from the general transient-failure retry
 * policy -- this is for a resource whose async job is expected to genuinely run for a while
 * (an identity resolution match job, a calculated insight processing run), not a transient
 * failure to retry past. Per explicit product guidance: submit, then poll on a fixed, short
 * interval until the status is correct, then move on -- no exponential backoff (which would
 * otherwise widen the gap between consecutive status updates shown to the user as a job runs
 * long), bounded by an overall timeout so a genuinely stuck job doesn't hang `apply` forever.
 */
export const DEFAULT_JOB_POLLING_POLICY: JobPollingPolicy = {
  intervalMs: 2_000,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
};

export type JobStatus<R> =
  | { terminal: true; result: R }
  | { terminal: true; failed: true; reason: string }
  | { terminal: false; status?: string };

export class JobTimeoutError extends Error {}

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submit/poll/terminal-state pattern shared by every async Data 360 job (ingestion run,
 * identity resolution activation run, CI processing run, segment qualification run,
 * activation run). `poll` is called repeatedly, every `policy.intervalMs`, until it reports a
 * terminal status or the overall timeout elapses. `onPoll`, when supplied, is called with each
 * non-terminal status string observed, so a caller can surface live progress to the user instead
 * of only a single "waiting..." message that then goes silent until the job finishes.
 */
export async function waitForJobCompletion<R>(
  poll: () => Promise<JobStatus<R>>,
  policy: JobPollingPolicy = DEFAULT_JOB_POLLING_POLICY,
  onPoll?: (status: string | undefined) => void,
  sleep: Sleep = defaultSleep,
  now: () => number = Date.now
): Promise<R> {
  const deadline = now() + policy.timeoutMs;

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- polling is inherently sequential.
    const status = await poll();
    if (status.terminal) {
      if ('failed' in status && status.failed) {
        throw new Error(`Job failed: ${status.reason}`);
      }
      return (status as { terminal: true; result: R }).result;
    }
    onPoll?.(status.status);

    if (now() >= deadline) {
      throw new JobTimeoutError(`Job did not reach a terminal state within ${policy.timeoutMs}ms`);
    }

    // eslint-disable-next-line no-await-in-loop -- waiting out the fixed poll interval before the next check.
    await sleep(policy.intervalMs);
  }
}
