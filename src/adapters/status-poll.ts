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
import { JobStatus, waitForJobCompletion } from '../retry/job-polling.js';
import { AdapterContext, AdapterReadResult } from './types.js';

export type StatusPollConfig = {
  /** Re-reads the resource's current state, typically `adapter.read(ctx, id)`. */
  read: () => Promise<AdapterReadResult>;
  /** Picks the status string out of a read result's properties. */
  statusOf: (result: AdapterReadResult) => string | undefined;
  terminalValues: string[];
  failureValues: string[];
  /** Called with each non-terminal status string observed, every poll, for live progress reporting. */
  onPoll?: (status: string | undefined) => void;
};

/**
 * No Data 360 resource type exposes a dedicated poll-by-jobId endpoint: every async action's
 * completion is observed by re-reading the resource itself and checking a status field. Call
 * this after submitting the action (e.g. a POST to an `actions/<verb>` endpoint). Polls on a
 * fixed, short interval (`DEFAULT_JOB_POLLING_POLICY`, no backoff) per explicit product
 * guidance: submit, then poll until the status is correct, surfacing each poll's status to the
 * caller via `onPoll`.
 */
export async function pollUntilStatus(config: StatusPollConfig): Promise<Record<string, unknown>> {
  return waitForJobCompletion<Record<string, unknown>>(
    async (): Promise<JobStatus<Record<string, unknown>>> => {
      const result = await config.read();
      const status = result ? config.statusOf(result) : undefined;

      if (status !== undefined && config.failureValues.includes(status)) {
        return { terminal: true, failed: true, reason: `status=${status}` };
      }
      if (status !== undefined && config.terminalValues.includes(status)) {
        return { terminal: true, result: result?.properties ?? {} };
      }
      return { terminal: false, status };
    },
    undefined,
    config.onPoll
  );
}

/** Fires an action endpoint whose response body isn't relied on (status is read back separately). */
export async function postAction(ctx: AdapterContext, path: string, body?: unknown): Promise<void> {
  await ctx.client.request({ method: 'POST', path, body });
}
