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
import { ConnectRestClient } from '../connect-rest/client.js';

export type FieldChangeKind = 'replace' | 'update';

/** Per-field replace-vs-update classification, seeded from the Section 11 tables (provisional). */
export type FieldClassification = Record<string, FieldChangeKind>;

export type AdapterReadResult =
  | {
      id: string;
      apiName?: string;
      properties: Record<string, unknown>;
    }
  | undefined;

export type AdapterContext = {
  client: ConnectRestClient;
  journaled?: boolean;
  /**
   * Called by an `AsyncJobAdapter`'s `waitForCompletion`, once per poll, with the status string
   * observed -- lets a caller (the apply executor) surface live job progress to the user instead
   * of only a single "waiting..." message that then goes silent until the job finishes. Optional:
   * omitted entirely by every adapter unit test, and by any caller that doesn't need live
   * progress reporting.
   */
  onJobPoll?: (status: string | undefined) => void;
};

/**
 * Common interface every resource-type adapter implements. This -- together with
 * ConnectRestClient -- is the seam between this plugin and the real Data 360 Connect REST API:
 * every adapter's request/response handling for its resource type lives entirely behind this
 * interface, so engine/graph/plan/apply logic never needs to know real endpoint shapes.
 */
export type DeletionObservation = { outcome: 'absent' | 'deleting' | 'present' | 'unknown'; status?: string };

export interface ResourceAdapter {
  readonly type: string;
  readonly fieldClassification: FieldClassification;
  readonly deletionCapability?: 'standalone' | 'parent-cascade-only';
  readonly setLikePaths?: string[];
  readonly clearablePaths?: Record<string, unknown>;

  /** Looks up a live object by its lookup key (API name by default). Used by refresh/adoption/import. */
  lookup(ctx: AdapterContext, lookupKey: Record<string, unknown>): Promise<AdapterReadResult>;

  observeDeletion?(ctx: AdapterContext, id: string): Promise<DeletionObservation>;

  /** Reads the current live state of an already-tracked resource by id. */
  read(ctx: AdapterContext, id: string): Promise<AdapterReadResult>;

  create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult>;

  update(ctx: AdapterContext, id: string, properties: Record<string, unknown>): Promise<AdapterReadResult>;

  delete(
    ctx: AdapterContext,
    id: string
  ): Promise<void | { outcome: 'deleted' | 'absent' | 'unsupported' | 'uncertain' }>;
}

/** Implemented by adapters for resource types backed by an async submit/poll/terminal job. */
export interface AsyncJobAdapter {
  /** Submits and polls the type's async job (ingestion run, activation run, processing run, ...) to completion. */
  waitForCompletion(ctx: AdapterContext, id: string): Promise<Record<string, unknown>>;
}

export function hasAsyncJob(adapter: ResourceAdapter): adapter is ResourceAdapter & AsyncJobAdapter {
  return typeof (adapter as Partial<AsyncJobAdapter>).waitForCompletion === 'function';
}
