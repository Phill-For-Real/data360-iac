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
export type ChangeAction = 'create' | 'update-in-place' | 'replace' | 'no-op';

export type PlannedChange = {
  key: string;
  type: string;
  name: string;
  action: ChangeAction;
  /** Set when `action` is 'replace' and this resource has downstream dependents that will be affected. */
  cascadeWarning?: string[];
};

export type AdoptionCandidate = {
  key: string;
  type: string;
  name: string;
  liveId: string;
  /** True when the live object's properties already match the manifest's declared properties exactly. */
  cleanAdopt: boolean;
};

/**
 * One resource's adoption/refresh lookup raised an error instead of returning found-or-not-found
 * (e.g. the real endpoint 404s for a resource type that isn't provisioned/enabled in this org).
 * The resource is still planned as a `create` (or left at its prior tracked action, for a
 * refresh failure) -- one adapter's live-state check failing is never allowed to abort planning
 * for every other resource in the manifest. The real API gets the final say at apply time.
 */
export type PlanningWarning = {
  key: string;
  type: string;
  name: string;
  message: string;
};

export type SafetyBlocker = { key: string; code: string; message: string };
export type CascadeReview = {
  parentKey: string;
  parentId: string;
  scopeHash: string;
  rules: Array<{ id: string; name: string; managedKey?: string; protected: boolean; fingerprint: string }>;
};
export type Plan = {
  version?: 2;
  identity?: { orgId: string; dataSpace: string; lineage: string; serial: number; manifestHash: string };
  blockers?: SafetyBlocker[];
  cascades?: CascadeReview[];
  changes: PlannedChange[];
  adoptionCandidates: AdoptionCandidate[];
  destroys: PlannedChange[];
  warnings: PlanningWarning[];
  summary: {
    create: number;
    update: number;
    replace: number;
    destroy: number;
    noOp: number;
    total: number;
  };
};
