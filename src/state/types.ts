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
import type { CascadeReview } from '../plan/types.js';
export type OrgFingerprint = {
  orgId: string;
  instanceUrl: string;
  targetOrgAlias: string;
  dataSpace: string;
};

export type DeletionFailure = { code: string; statusCode?: number; timeoutMs?: number };

export type StateResourceEntry = {
  kind: 'resource' | 'data';
  type: string;
  name: string;
  declaredBy?: string;
  id?: string;
  apiName?: string;
  propertiesHash?: string;
  dependencies: string[];
  adopted?: boolean;
  lastAppliedAt?: string;
  lifecyclePending?: 'ready' | 'action-dispatching' | 'action-confirmed';
  lifecycleActionPath?: string;
  deletionCascade?: CascadeReview;
  deletionPending?: 'dispatching' | 'acknowledged';
  deletionFailure?: DeletionFailure;
  intentVersion?: 1;
  lastAppliedIntent?: Record<string, unknown>;
  managedPaths?: string[];
  protected?: boolean;
  outputs?: Record<string, unknown>;
};

export const STATE_FORMAT_VERSION = '2.0';

export type StateFile = {
  formatVersion: string;
  orgFingerprint: OrgFingerprint;
  serial: number;
  lineage: string;
  resources: StateResourceEntry[];
};

export function emptyState(orgFingerprint: OrgFingerprint, lineage: string): StateFile {
  return {
    formatVersion: STATE_FORMAT_VERSION,
    orgFingerprint,
    serial: 0,
    lineage,
    resources: [],
  };
}
