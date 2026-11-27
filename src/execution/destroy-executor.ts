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
import { OperationJournal, JournalClient, journalFor } from '../state/journal.js';
import { CascadeReview } from '../plan/types.js';
import { RequestTimeoutError } from '../connect-rest/client.js';
import { AdapterContext, DeletionObservation } from '../adapters/types.js';
import { getAdapter } from '../adapters/registry.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { StateStore } from '../state/store.js';
import { StateFile, StateResourceEntry, DeletionFailure } from '../state/types.js';
import { checkDeletionReview } from './deletion-safety.js';

export class ProtectedResourceError extends Error {}
export class UnsupportedDeleteError extends Error {
  public readonly code = 'UNSUPPORTED_DELETE';
  public constructor(public readonly key: string) {
    super(
      `Standalone deletion of ${key} is unsupported. A complete reviewed parent cascade is required; cascade execution is not yet available. State retained.`
    );
    this.name = 'UNSUPPORTED_DELETE';
  }
}
export class UncertainDeleteError extends Error {
  public readonly code = 'UNCERTAIN_DELETE';
  public constructor(public readonly key: string) {
    super(
      `Deletion of ${key} is unresolved. State retained; inspect with destroy --reconcile-only. No DELETE will be replayed.`
    );
    this.name = 'UNCERTAIN_DELETE';
  }
}
export class DeleteInProgressError extends Error {
  public readonly code = 'DELETE_IN_PROGRESS';
  public constructor(key: string) {
    super(
      `Deletion of ${key} is still in progress. Tracking retained after bounded read-only polling; inspect with destroy --reconcile-only. No DELETE will be replayed.`
    );
    this.name = 'DELETE_IN_PROGRESS';
  }
}
export type DeletionPolling = {
  attempts?: number;
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};
export type DestroyProgressEvent =
  | { type: 'resource-start'; key: string }
  | { type: 'resource-done'; key: string }
  | { type: 'resource-delete-status'; key: string; status: string }
  | { type: 'resource-failed'; key: string; error: Error };
export type DestroyExecutorOptions = {
  graph: DependencyGraph;
  state: StateFile;
  store: StateStore;
  ctx: AdapterContext;
  protectedKeys: Set<string>;
  journalLockHeld?: boolean;
  cascades?: CascadeReview[];
  cascadeApprovals?: string[];
  deletionKeys?: Set<string>;
  concurrency?: number;
  reconcileOnly?: boolean;
  deletionPolling?: DeletionPolling;
  onProgress?: (event: DestroyProgressEvent) => void;
};
export type DestroyResult = {
  destroyed: string[];
  pending?: Array<{
    key: string;
    id: string;
    phase: string;
    reason: string;
    observedStatus?: string;
    lastFailure?: DeletionFailure;
  }>;
  failure?: { key: string; error: Error };
};
export class DestroyExecutor {
  private state: StateFile;
  private readonly journal: OperationJournal;
  private readonly observations = new Map<string, DeletionObservation>();
  public constructor(private readonly options: DestroyExecutorOptions) {
    this.state = options.state;
    this.journal = journalFor(options.store.paths, options.state);
  }
  public async run(): Promise<DestroyResult> {
    if (!this.options.journalLockHeld) await this.journal.acquire();
    try {
      return await this.runLocked();
    } finally {
      if (!this.options.journalLockHeld) await this.journal.release();
    }
  }
  private async runLocked(): Promise<DestroyResult> {
    const { graph, protectedKeys, reconcileOnly } = this.options;
    const order = [...graph.topologicalOrder()].reverse();
    const tracked = new Set(
      this.state.resources
        .filter(
          (entry) =>
            entry.kind === 'resource' &&
            (!this.options.deletionKeys || this.options.deletionKeys.has(`${entry.type}.${entry.name}`))
        )
        .map((entry) => `${entry.type}.${entry.name}`)
    );
    const graphKeys = new Set(order);
    const keys = [...order.filter((key) => tracked.has(key)), ...[...tracked].filter((key) => !graphKeys.has(key))];
    if (!reconcileOnly) {
      const protectedKey = keys.find((key) => protectedKeys.has(key));
      if (protectedKey)
        return {
          destroyed: [],
          failure: {
            key: protectedKey,
            error: new ProtectedResourceError(
              `"${protectedKey}" is marked protect: true and cannot be destroyed without an explicit override`
            ),
          },
        };
    }
    if (!reconcileOnly) {
      try {
        await checkDeletionReview(
          this.state,
          new Set(keys),
          this.options.ctx,
          this.options.cascades,
          this.options.cascadeApprovals,
          protectedKeys
        );
        // Legacy pending deletes are reconciled below; journals for other writes must pause destroy.
        const pending = await this.journal.pending();
        if (pending.some((r) => r.operation !== 'delete')) await this.journal.assertReady();
      } catch (error) {
        return { destroyed: [], failure: { key: 'preflight', error: error as Error } };
      }
    }
    const destroyed: string[] = [];
    // Reconcile every unresolved delete before allowing any new write in this scope.
    for (const entry of [...this.state.resources].filter((resource) => resource.deletionPending)) {
      const key = `${entry.type}.${entry.name}`;
      try {
        // eslint-disable-next-line no-await-in-loop -- read-only reconciliation is scoped and sequential.
        if (!(await this.confirmAbsent(entry))) return this.uncertain(key, destroyed);
        // eslint-disable-next-line no-await-in-loop -- atomic state repair after authoritative absence.
        await this.commitRemoval(key);
        destroyed.push(key);
      } catch (error) {
        return { destroyed, failure: { key, error: error as Error }, pending: this.pending() };
      }
    }
    if (reconcileOnly) return { destroyed, pending: this.pending() };
    for (const key of keys) {
      const entry = this.state.resources.find((resource) => `${resource.type}.${resource.name}` === key);
      if (!entry?.id || entry.type === 'AccessPolicyRule') continue;
      this.options.onProgress?.({ type: 'resource-start', key });
      try {
        // eslint-disable-next-line no-await-in-loop -- persist intent before each sequential delete.
        if (!(await this.deleteAndConfirm(entry, key))) return this.uncertain(key, destroyed);
        // eslint-disable-next-line no-await-in-loop -- per-resource final state commit.
        await this.commitRemoval(key);
        destroyed.push(key);
        this.options.onProgress?.({ type: 'resource-done', key });
      } catch (error) {
        this.options.onProgress?.({ type: 'resource-failed', key, error: error as Error });
        return { destroyed, failure: { key, error: error as Error }, pending: this.pending() };
      }
    }
    return { destroyed, pending: this.pending() };
  }
  private async deleteAndConfirm(entry: StateResourceEntry, key: string): Promise<boolean> {
    if (entry.type === 'AccessPolicy') {
      await checkDeletionReview(
        this.state,
        new Set([key]),
        this.options.ctx,
        this.options.cascades,
        this.options.cascadeApprovals,
        this.options.protectedKeys
      );
    }
    await this.checkpoint(key, 'dispatching');
    let acknowledged = false;
    try {
      const client = new JournalClient(this.options.ctx.client, this.journal, {
        key,
        type: entry.type,
        intent: entry.lastAppliedIntent ?? {},
        planId: JSON.stringify(this.options.cascades ?? []),
        operation: 'delete',
        remoteId: entry.id,
      });
      const result = await getAdapter(entry.type).delete({ ...this.options.ctx, journaled: true, client }, entry.id!);
      const outcome = (result as unknown as { outcome?: string } | undefined)?.outcome;
      acknowledged = outcome === undefined || outcome === 'deleted' || outcome === 'absent';
      if (acknowledged) await this.checkpoint(key, 'acknowledged');
    } catch (error) {
      // Keep a safe classification, never a raw error body, request body or resolved credential.
      await this.recordFailure(key, error);
    }
    // Targets have exhibited ambiguous/asynchronous delete results and require absence proof.
    // Successful legacy adapters retain their existing acknowledgement contract.
    return acknowledged &&
      entry.type !== 'ActivationTarget' &&
      entry.type !== 'AccessPolicy' &&
      !getAdapter(entry.type).observeDeletion
      ? true
      : this.confirmAbsent(entry);
  }

  // eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
  private async recordFailure(key: string, error: unknown): Promise<void> {
    const value = error as
      | {
          name?: string;
          errorCode?: string;
          statusCode?: number;
          status?: number;
          message?: string;
          timeoutMs?: number;
        }
      | undefined;
    const status = value?.statusCode ?? value?.status;
    const message = value?.message ?? '';
    const timeout =
      value?.timeoutMs ??
      (error instanceof RequestTimeoutError ? error.timeoutMs : /^Request timed out after (\d+)ms$/.exec(message)?.[1]);
    const providerCodes = [
      'INVALID_INPUT',
      'BAD_REQUEST',
      'DEPENDENCY_EXISTS',
      'INVALID_SESSION_ID',
      'INSUFFICIENT_ACCESS',
      'ITEM_NOT_FOUND',
      'NOT_FOUND',
      'RESOURCE_NOT_FOUND',
      'UNKNOWN_EXCEPTION',
      'INTERNAL_ERROR',
    ];
    const provider = value?.errorCode ?? value?.name;
    const failure: DeletionFailure = {
      code:
        timeout !== undefined
          ? 'REQUEST_TIMEOUT'
          : provider && providerCodes.includes(provider)
          ? provider
          : 'UNKNOWN_ERROR',
      statusCode:
        typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600 ? status : undefined,
      timeoutMs: timeout !== undefined ? Number(timeout) : undefined,
    };
    const resources = this.state.resources.map((entry) =>
      `${entry.type}.${entry.name}` === key ? { ...entry, deletionFailure: failure } : entry
    );
    this.state = await this.options.store.write({ ...this.state, resources });
  }

  private async confirmAbsent(entry: StateResourceEntry): Promise<boolean> {
    const key = `${entry.type}.${entry.name}`;
    const policy = this.options.deletionPolling ?? {};
    const now = policy.now ?? Date.now;
    const deadline = now() + (policy.timeoutMs ?? 30_000);
    const attempts = policy.attempts ?? 15;
    const sleep =
      policy.sleep ?? ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      // eslint-disable-next-line no-await-in-loop -- bounded read-only polling, never replay DELETE.
      const observation = await this.observeDeletion(entry);
      const display = observation.status ?? observation.outcome;
      const previous = this.observations.get(key);
      if ((previous?.status ?? previous?.outcome) !== display)
        this.options.onProgress?.({ type: 'resource-delete-status', key, status: display });
      this.observations.set(key, observation);
      if (observation.outcome === 'absent') return true;
      if (now() >= deadline || attempt + 1 >= attempts) break;
      // eslint-disable-next-line no-await-in-loop -- fixed short interval, injected in deterministic tests.
      await sleep(policy.intervalMs ?? 2_000);
    }
    return false;
  }
  private async observeDeletion(entry: StateResourceEntry): Promise<DeletionObservation> {
    if (!entry.id) return { outcome: 'unknown' };
    const adapter = getAdapter(entry.type);
    if (adapter.observeDeletion) return adapter.observeDeletion(this.options.ctx, entry.id);
    try {
      const live = await adapter.read(this.options.ctx, entry.id);
      if (!live) return { outcome: 'unknown' };
      const status = live.properties.status;
      return typeof status === 'string'
        ? { outcome: status.toUpperCase().includes('DELET') ? 'deleting' : 'present', status }
        : { outcome: 'present' };
    } catch (error) {
      const response = error as { statusCode?: number; status?: number } | undefined;
      return (response?.statusCode ?? response?.status) === 404 ? { outcome: 'absent' } : { outcome: 'unknown' };
    }
  }
  private async checkpoint(key: string, phase: NonNullable<StateResourceEntry['deletionPending']>): Promise<void> {
    const resources = this.state.resources.map((entry) =>
      `${entry.type}.${entry.name}` === key
        ? {
            ...entry,
            deletionPending: phase,
            deletionCascade: entry.deletionCascade ?? this.options.cascades?.find((r) => r.parentKey === key),
          }
        : entry
    );
    this.state = await this.options.store.write({ ...this.state, resources });
  }
  private async commitRemoval(key: string): Promise<void> {
    const parent = this.state.resources.find((r) => `${r.type}.${r.name}` === key);
    const cascade =
      parent?.type === 'AccessPolicy'
        ? parent.deletionCascade ?? this.options.cascades?.find((r) => r.parentKey === key)
        : undefined;
    if (cascade) {
      for (const rule of cascade.rules) {
        // eslint-disable-next-line no-await-in-loop -- confirm each reviewed child absence before releasing tracking.
        const absent = await this.observeDeletion({
          kind: 'resource',
          type: 'AccessPolicyRule',
          name: rule.name,
          id: rule.id,
          dependencies: [],
        });
        if (absent.outcome !== 'absent') throw new UncertainDeleteError(key);
      }
    }
    this.state = await this.options.store.write({
      ...this.state,
      resources: this.state.resources.filter(
        (entry) => `${entry.type}.${entry.name}` !== key && !cascade?.rules.some((rule) => rule.id === entry.id)
      ),
    });
    await this.journal.stateVersion(this.state.serial);
    await this.journal.confirmDeletion(key);
    await this.journal.commitResource(key);
  }
  private pending(): NonNullable<DestroyResult['pending']> {
    return this.state.resources
      .filter((entry) => entry.deletionPending)
      .map((entry) => ({
        key: `${entry.type}.${entry.name}`,
        id: entry.id ?? '',
        phase: String(entry.deletionPending),
        reason: 'Awaiting authoritative member-GET absence; do not replay deletion.',
        observedStatus: this.observations.get(`${entry.type}.${entry.name}`)?.status,
        lastFailure: entry.deletionFailure,
      }));
  }
  private uncertain(key: string, destroyed: string[]): DestroyResult {
    const error =
      this.observations.get(key)?.outcome === 'deleting'
        ? new DeleteInProgressError(key)
        : new UncertainDeleteError(key);
    this.options.onProgress?.({ type: 'resource-failed', key, error });
    return { destroyed, pending: this.pending(), failure: { key, error } };
  }
}
