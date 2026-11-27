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
import { ConnectRestClient, ConnectRestRequest } from '../connect-rest/client.js';
import { AdapterContext } from '../adapters/types.js';
import { getAdapter } from '../adapters/registry.js';
import { hasAsyncJob } from '../adapters/types.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { blockKey, DataBlock, LoadedManifest, ResourceBlock } from '../manifest/types.js';
import { StateStore } from '../state/store.js';
import { StateFile, StateResourceEntry } from '../state/types.js';
import { OperationJournal, JournalClient, journalFor } from '../state/journal.js';
import { apiProperties, managedPaths, removalPayload } from '../plan/diff.js';
import { Plan } from '../plan/types.js';
import { computePropertiesHash } from '../plan/properties-hash.js';
import { safeIntent } from '../plan/safe-intent.js';
import { SecretResolverRegistry, resolveSecrets } from '../secrets/resolve-secrets.js';
import { EnvSecretSource } from '../secrets/env-secret-source.js';
import { checkDeletionReview, SafetyError } from './deletion-safety.js';
import { ConcurrencyLimiter } from './concurrency-limiter.js';
import { resolveReferences, ResolvedOutputs } from './resolve-references.js';
import { stageForType, STAGES } from './stages.js';
import { reconcileOperations } from './reconcile-operations.js';
import { DestroyExecutor } from './destroy-executor.js';
import { WorkItem, WorkItemKind } from './work-item.js';

const DEFAULT_SECRET_RESOLVERS: SecretResolverRegistry = {
  env: new EnvSecretSource(),
  // No default keychain backend is wired here: interactive callers must supply one explicitly.
  keychain: {
    resolve() {
      return Promise.reject(new Error('$secret: no keychain resolver configured for this run'));
    },
  },
};

export type ApplyProgressEvent =
  | { type: 'stage-start'; stageName: string; keys: string[] }
  | { type: 'resource-start'; key: string }
  | { type: 'resource-waiting-job'; key: string }
  | { type: 'resource-job-status'; key: string; status: string | undefined }
  | { type: 'resource-done'; key: string }
  | { type: 'resource-failed'; key: string; error: Error };

export type ApplyExecutorOptions = {
  manifest: LoadedManifest;
  graph: DependencyGraph;
  plan: Plan;
  state: StateFile;
  store: StateStore;
  ctx: AdapterContext;
  baselineLegacy?: boolean;
  cascadeApprovals?: string[];
  concurrency?: number;
  step?: boolean;
  onStageComplete?: (stageName: string) => Promise<boolean>;
  /** Fired at each stage/resource lifecycle point, live, for progress reporting -- see Data360Apply. */
  onProgress?: (event: ApplyProgressEvent) => void;
  secretResolvers?: SecretResolverRegistry;
};

export type ApplyFailure = {
  key: string;
  error: Error;
};

export type ApplyResult = {
  completed: string[];
  failure?: ApplyFailure;
  haltedAt?: string;
};

function resourceBlocksByKey(manifest: LoadedManifest): Map<string, ResourceBlock> {
  const map = new Map<string, ResourceBlock>();
  for (const block of manifest.blocks) {
    if ((block.kind ?? 'resource') === 'resource') {
      map.set(blockKey(block), block as ResourceBlock);
    }
  }
  return map;
}

function dataBlocksByKey(manifest: LoadedManifest): Map<string, DataBlock> {
  const map = new Map<string, DataBlock>();
  for (const block of manifest.blocks) {
    if (block.kind === 'data') {
      map.set(blockKey(block), block);
    }
  }
  return map;
}

/**
 * Walks the resource graph in fine-grained topological order, running ready nodes up to a
 * concurrency limit, submitting/polling async jobs to a terminal state, and writing state after
 * each individual resource completes (Section 10's "apply in detail") -- so a mid-graph failure
 * never requires a full teardown-and-retry (Section 13). The six named stages (Section 5) are
 * used only for --step pause points and grouping; they never constrain execution order.
 */
export class ApplyExecutor {
  private readonly manifest: LoadedManifest;
  private readonly graph: DependencyGraph;
  private readonly plan: Plan;
  private state: StateFile;
  private readonly store: StateStore;
  private readonly ctx: AdapterContext;
  private readonly limiter: ConcurrencyLimiter;
  private readonly step: boolean;
  private readonly onStageComplete?: (stageName: string) => Promise<boolean>;
  private readonly onProgress?: (event: ApplyProgressEvent) => void;
  private readonly secretResolvers: SecretResolverRegistry;
  private readonly preEvidence = new Map<string, string[]>();
  private readonly outputs: ResolvedOutputs = new Map();
  private readonly journal: OperationJournal;
  private readonly baselineLegacy: boolean;
  private readonly cascadeApprovals: string[];
  private stateWriteQueue: Promise<void> = Promise.resolve();

  public constructor(options: ApplyExecutorOptions) {
    this.journal = journalFor(options.store.paths, options.state);
    this.baselineLegacy = options.baselineLegacy ?? false;
    this.cascadeApprovals = options.cascadeApprovals ?? [];
    this.manifest = options.manifest;
    this.graph = options.graph;
    this.plan = options.plan;
    this.state = options.state;
    this.store = options.store;
    this.ctx = options.ctx;
    this.limiter = new ConcurrencyLimiter(options.concurrency ?? 5);
    this.step = options.step ?? false;
    this.onStageComplete = options.onStageComplete;
    this.onProgress = options.onProgress;
    this.secretResolvers = options.secretResolvers ?? DEFAULT_SECRET_RESOLVERS;
    this.seedOutputsFromState();
  }

  public async run(): Promise<ApplyResult> {
    await this.journal.acquire();
    try {
      return await this.runLocked();
    } finally {
      await this.journal.release();
    }
  }
  // eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
  private async runLocked(): Promise<ApplyResult> {
    try {
      const pending = await this.journal.pending();
      if (pending.length && pending.every((r) => r.phase === 'confirmed' || r.phase === 'prepared')) {
        await reconcileOperations(this.journal, this.store, this.state, this.ctx);
        this.state = await this.store.read(this.state.orgFingerprint);
      }
      await this.journal.assertReady();
      if (this.plan.blockers?.length) throw new SafetyError(this.plan.blockers);
      await checkDeletionReview(
        this.state,
        new Set([...this.plan.destroys, ...this.plan.changes.filter((c) => c.action === 'replace')].map((c) => c.key)),
        this.ctx,
        this.plan.cascades,
        this.cascadeApprovals
      );
    } catch (error) {
      return { completed: [], failure: { key: 'preflight', error: error as Error } };
    }

    const deletion = this.state.resources.find((entry) => entry.deletionPending);
    if (deletion) {
      const key = `${deletion.type}.${deletion.name}`;
      return {
        completed: [],
        failure: {
          key,
          error: new Error(
            'Unresolved deletion blocks apply. Run destroy --reconcile-only; do not recreate or remove tracking.'
          ),
        },
        haltedAt: key,
      };
    }
    for (const entry of this.state.resources.filter((r) => r.lifecyclePending)) {
      const key = `${entry.type}.${entry.name}`;
      const block = resourceBlocksByKey(this.manifest).get(key);
      const hash = block
        ? computePropertiesHash(
            safeIntent(entry.lastAppliedIntent ? apiProperties(block.properties) : block.properties) as Record<
              string,
              unknown
            >
          )
        : undefined;
      const recordedHash = entry.lastAppliedIntent
        ? computePropertiesHash(entry.lastAppliedIntent)
        : entry.propertiesHash;
      if (entry.lifecyclePending === 'action-dispatching' || hash !== recordedHash) {
        const message =
          entry.lifecyclePending === 'action-dispatching'
            ? 'A lifecycle action has an uncertain result. Do not replay it; inspect the remote job and retain state.'
            : 'Pending lifecycle intent differs from this manifest. Restore the original manifest before resuming.';
        return { completed: [], failure: { key, error: new Error(message) }, haltedAt: key };
      }
    }
    const deletionKeys = new Set(
      [...this.plan.destroys, ...this.plan.changes.filter((c) => c.action === 'replace')].map((c) => c.key)
    );
    if (deletionKeys.size) {
      const deleted = await new DestroyExecutor({
        graph: this.graph,
        state: this.state,
        store: this.store,
        ctx: this.ctx,
        protectedKeys: new Set(
          this.manifest.blocks.filter((b) => b.kind !== 'data' && b.properties.protect === true).map(blockKey)
        ),
        deletionKeys,
        journalLockHeld: true,
        cascades: this.plan.cascades,
        cascadeApprovals: this.cascadeApprovals,
      }).run();
      if (deleted.failure) return { completed: [], failure: deleted.failure };
      this.state = await this.store.read(this.state.orgFingerprint);
    }
    await this.resolveDataBlocks();
    await this.refreshNoOpOutputs();
    // A reviewed no-op apply can establish declared intent for legacy entries using local writes only.
    for (const change of this.plan.changes.filter((c) => c.action === 'no-op')) {
      const entry = this.state.resources.find((e) => `${e.type}.${e.name}` === change.key);
      const block = resourceBlocksByKey(this.manifest).get(change.key);
      if (
        entry &&
        block &&
        entry.id &&
        ((this.baselineLegacy && !entry.intentVersion) ||
          entry.protected !== (block.properties.protect === true) ||
          (entry.lastAppliedIntent &&
            computePropertiesHash(entry.lastAppliedIntent) !==
              computePropertiesHash(safeIntent(apiProperties(block.properties)) as Record<string, unknown>)))
      ) {
        // eslint-disable-next-line no-await-in-loop -- local baseline commit after approved planning.
        await this.writeResourceState(
          { key: change.key, type: block.type, name: block.name, kind: 'adopt-clean', block },
          entry.id,
          entry.apiName,
          block.properties
        );
      }
    }
    const workItems = this.buildWorkItems();
    const completed: string[] = [];

    for (const stage of STAGES) {
      const stageItems = workItems.filter((item) => stageForType(item.type).number === stage.number);
      if (stageItems.length === 0) continue;

      this.onProgress?.({ type: 'stage-start', stageName: stage.name, keys: stageItems.map((i) => i.key) });

      // eslint-disable-next-line no-await-in-loop -- stages are fixed pause points, strictly sequential by design.
      const result = await this.runStage(stageItems);
      completed.push(...result.completed);

      if (result.failure) {
        return { completed, failure: result.failure, haltedAt: result.failure.key };
      }

      if (this.step && this.onStageComplete) {
        // eslint-disable-next-line no-await-in-loop -- waiting on the user's confirmation before the next stage.
        const shouldContinue = await this.onStageComplete(stage.name);
        if (!shouldContinue) {
          return { completed };
        }
      }
    }

    return { completed };
  }

  private async runStage(items: WorkItem[]): Promise<{ completed: string[]; failure?: ApplyFailure }> {
    const remaining = new Set(items.map((i) => i.key));
    const itemsByKey = new Map(items.map((i) => [i.key, i]));
    const completed: string[] = [];
    let failure: ApplyFailure | undefined;

    while (remaining.size > 0 && !failure) {
      const ready = [...remaining].filter((key) => this.dependenciesSatisfied(key, remaining));
      if (ready.length === 0) {
        // No ready node but items remain: a dependency outside this stage never completed
        // (upstream failure), or a true cycle slipped past validate. Treat as a hard failure.
        const stuckKey = [...remaining][0];
        failure = { key: stuckKey, error: new Error(`"${stuckKey}" has unresolved dependencies and cannot proceed`) };
        break;
      }

      // eslint-disable-next-line no-await-in-loop -- each wave must finish before checking the next.
      const results = await Promise.all(
        ready.map((key) =>
          this.limiter.run(async () => {
            this.onProgress?.({ type: 'resource-start', key });
            try {
              await this.executeItem(itemsByKey.get(key)!);
              this.onProgress?.({ type: 'resource-done', key });
              return { key, ok: true as const };
            } catch (e) {
              this.onProgress?.({ type: 'resource-failed', key, error: e as Error });
              return { key, ok: false as const, error: e as Error };
            }
          })
        )
      );

      for (const result of results) {
        remaining.delete(result.key);
        if (result.ok) {
          completed.push(result.key);
        } else {
          failure ??= { key: result.key, error: result.error };
        }
      }
    }

    return { completed, failure };
  }

  private dependenciesSatisfied(key: string, remainingInStage: Set<string>): boolean {
    return this.graph.getDependencies(key).every((dep) => !remainingInStage.has(dep) && this.outputs.has(dep));
  }

  /**
   * `kind: "data"` blocks never go through plan/create/update -- they're a read-only lookup
   * against something that already exists live, used only so other blocks can reference its id
   * via `${Type.name.field}` (see DependencyGraph, which already wires edges for these). Resolved
   * once, upfront, sequentially (same rationale as PlanEngine's refresh pass: a bounded,
   * predictable request rate against Connect REST).
   */
  private async resolveDataBlocks(): Promise<void> {
    const blocks = dataBlocksByKey(this.manifest);
    if (blocks.size === 0) return;

    // Resolve in topological order, not manifest order: a data block's lookup can itself
    // reference another block (data or resource) via ${Type.name.field}.
    for (const key of this.graph.topologicalOrder()) {
      const block = blocks.get(key);
      if (!block) continue;

      const adapter = getAdapter(block.type);
      const resolvedLookup = resolveReferences(block.lookup, this.outputs) as Record<string, unknown>;
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see method doc.
      const live = await adapter.lookup(this.ctx, resolvedLookup);
      if (!live) {
        throw new Error(
          `Data block "${key}" could not be resolved: no live ${block.type} matches ${JSON.stringify(block.lookup)}`
        );
      }
      this.outputs.set(key, { id: live.id, apiName: live.apiName, ...live.properties });
    }
  }

  /**
   * A `no-op` resource never gets a WorkItem (buildWorkItems skips it), so it would otherwise
   * keep only the partial `{id, apiName}` seeded from state in the constructor -- missing any
   * other adapter output (e.g. DataStream's `dlApiName`) a downstream block might reference via
   * `${Type.name.field}`. Re-reads each no-op resource's live state once, upfront (same
   * sequential, bounded-rate rationale as resolveDataBlocks/PlanEngine.refresh), and overwrites
   * its seeded outputs with the full live result. One resource's read failing must never abort
   * the run -- same isolation principle as PlanEngine.refresh's per-entry try/catch; the resource
   * is simply left with its partial state-seeded outputs, and a downstream reference to a field
   * only the live read would have provided fails with a clear "has not been resolved yet" error.
   */
  private async refreshNoOpOutputs(): Promise<void> {
    const noOpKeys = new Set(this.plan.changes.filter((c) => c.action === 'no-op').map((c) => c.key));
    if (noOpKeys.size === 0) return;

    for (const entry of this.state.resources) {
      const key = `${entry.type}.${entry.name}`;
      if (!noOpKeys.has(key) || !entry.id) continue;

      const adapter = getAdapter(entry.type);
      try {
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential, see method doc.
        const live = await adapter.read(this.ctx, entry.id);
        if (live) {
          this.outputs.set(key, { id: live.id, apiName: live.apiName, ...live.properties });
        }
      } catch {
        // Leave the constructor's partial {id, apiName} seed in place; see method doc.
      }
    }
  }

  private async lifecycleClient(item: WorkItem, id: string, apiName: string | undefined): Promise<ConnectRestClient> {
    if (item.kind !== 'resume-lifecycle')
      await this.writeResourceState(item, id, apiName, item.block.properties, 'ready');
    return {
      request: async <T>(request: ConnectRestRequest): Promise<T> => {
        if (request.method === 'GET') return this.ctx.client.request<T>(request);
        const checkpoint = this.state.resources.find((entry) => `${entry.type}.${entry.name}` === item.key);
        if (checkpoint?.lifecyclePending === 'action-confirmed' && checkpoint.lifecycleActionPath === request.path)
          return {} as T;
        await this.writeResourceState(item, id, apiName, item.block.properties, 'action-dispatching', request.path);
        const response = await this.journalClient(item, id, 'action').request<T>(request);
        await this.writeResourceState(item, id, apiName, item.block.properties, 'action-confirmed', request.path);
        return response;
      },
    };
  }

  private async executeDefinition(
    item: WorkItem,
    properties: Record<string, unknown>
  ): Promise<{ id: string; apiName?: string; properties: Record<string, unknown> }> {
    const adapter = getAdapter(item.type);
    const ctx: AdapterContext = { ...this.ctx, journaled: true, client: this.journalClient(item) };
    if (item.kind === 'resume-lifecycle' || item.kind === 'adopt-clean') {
      const id = item.adoptedId ?? this.findExistingId(item.key);
      const live = await adapter.read(this.ctx, id);
      if (!live) throw new Error(`Cannot resume/adopt ${item.key}: identified remote resource is unavailable`);
      return live;
    }
    if (item.kind === 'adopt-update' || item.kind === 'update-in-place') {
      const id = item.adoptedId ?? this.findExistingId(item.key);
      const updated = await adapter.update(ctx, id, properties);
      return { id, apiName: updated?.apiName, properties: updated?.properties ?? {} };
    }
    if (item.kind === 'replace') await adapter.delete(ctx, this.findExistingId(item.key));
    // Capture existing candidates without credentials or arbitrary response bodies. An
    // incomplete collection never establishes authoritative pre-creation absence.
    const before: string[] = [];
    const evidenceCtx: AdapterContext = {
      client: {
        request: async <T>(request: ConnectRestRequest): Promise<T> => {
          if (request.method !== 'GET') throw new Error('Creation evidence must be read-only.');
          const response = await this.ctx.client.request<T>(request);
          const collect = (value: unknown): void => {
            if (Array.isArray(value)) {
              for (const candidate of value) {
                if (candidate && typeof candidate === 'object') {
                  const object = candidate as Record<string, unknown>;
                  const identity =
                    object.recordId ?? object.id ?? object.developerName ?? object.apiName ?? object.name;
                  if (typeof identity === 'string') before.push(identity);
                }
              }
            } else if (value && typeof value === 'object')
              for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
          };
          collect(response);
          return response;
        },
      },
    };
    const existing = await adapter.lookup(
      evidenceCtx,
      resolveReferences(apiProperties(item.block.properties), this.outputs) as Record<string, unknown>
    );
    if (existing)
      throw new Error('Creation scope changed after review: resource now exists. Generate a new plan; no write sent.');
    this.preEvidence.set(item.key, [...new Set(before)].sort());
    const created = await adapter.create({ ...ctx, client: this.journalClient(item) }, properties);
    if (!created) throw new Error(`Create returned no confirmed identity for ${item.key}`);
    return created;
  }

  private async executeItem(item: WorkItem): Promise<void> {
    const adapter = getAdapter(item.type);
    const entry = this.state.resources.find((e) => `${e.type}.${e.name}` === item.key);
    const intentPayload = removalPayload(
      apiProperties(item.block.properties),
      entry?.lastAppliedIntent,
      adapter.clearablePaths
    );
    const referencesResolved = resolveReferences(intentPayload, this.outputs) as Record<string, unknown>;
    const resolvedProperties = (
      item.kind === 'adopt-clean' ? referencesResolved : await resolveSecrets(referencesResolved, this.secretResolvers)
    ) as Record<string, unknown>;

    const { id, apiName, properties } = await this.executeDefinition(item, apiProperties(resolvedProperties));

    await this.journal.identifyResource(item.key, id, apiName);
    let jobOutputs: Record<string, unknown> = {};
    if (hasAsyncJob(adapter) && item.kind !== 'adopt-clean') {
      this.onProgress?.({ type: 'resource-waiting-job', key: item.key });
      // A per-call ctx (not a mutation of this.ctx, shared across resources running concurrently
      // in the same stage) so each resource's poll status is reported under its own key. Only
      // reported when the status actually changes -- a job that stays e.g. "PUBLISHING" for 30s
      // at a 2s poll interval would otherwise print 15 near-identical lines. `hasLogged` (not a
      // `string | undefined` sentinel initialized to `undefined`) is required here: a status
      // that's genuinely `undefined` on every poll (the status field never resolving) must still
      // log at least once -- `lastStatus === status` with both `undefined` would otherwise match
      // on the very first poll and suppress every progress event for the entire run, silently.
      let hasLogged = false;
      let lastStatus: string | undefined;
      const pollingCtx: AdapterContext = {
        ...this.ctx,
        client: await this.lifecycleClient(item, id, apiName),
        onJobPoll: (status) => {
          if (hasLogged && status === lastStatus) return;
          hasLogged = true;
          lastStatus = status;
          this.onProgress?.({ type: 'resource-job-status', key: item.key, status });
        },
      };
      jobOutputs = await adapter.waitForCompletion(pollingCtx, id);
    }

    const outputs = { ...properties, id, apiName, ...jobOutputs };
    this.outputs.set(item.key, outputs);

    // Hash the raw, unresolved manifest properties -- not the resolved ones passed to the
    // adapter -- so this matches exactly what PlanEngine hashes on the next plan/apply. Hashing
    // resolved values would make propertiesHash depend on other resources' live ids, which
    // would never again match once computed with a fresh set of outputs.
    await this.writeResourceState(item, id, apiName, item.block.properties);
    await this.journal.commitResource(item.key);
  }

  private journalClient(item: WorkItem, remoteId?: string, operation?: 'action'): JournalClient {
    const entry = this.state.resources.find((r) => `${r.type}.${r.name}` === item.key);
    return new JournalClient(this.ctx.client, this.journal, {
      key: item.key,
      type: item.type,
      intent: safeIntent(apiProperties(item.block.properties)) as Record<string, unknown>,
      planId: computePropertiesHash(this.plan),
      operation: operation ?? (item.kind === 'create' ? 'create' : 'update'),
      remoteId: remoteId ?? item.adoptedId ?? entry?.id,
      lookup: safeIntent(resolveReferences(apiProperties(item.block.properties), this.outputs)) as Record<
        string,
        unknown
      >,
      protected: item.block.properties.protect === true,
      dependencies: this.graph.getDependencies(item.key),
      preOperationIds: this.preEvidence.get(item.key),
      preOperationComplete: false,
    });
  }

  private findExistingId(key: string): string {
    const entry = this.state.resources.find((r) => `${r.type}.${r.name}` === key);
    if (!entry?.id) {
      throw new Error(`Cannot update/replace "${key}": no id recorded in state`);
    }
    return entry.id;
  }

  private writeResourceState(
    item: WorkItem,
    id: string,
    apiName: string | undefined,
    properties: Record<string, unknown>,
    lifecyclePending?: StateResourceEntry['lifecyclePending'],
    lifecycleActionPath?: string
  ): Promise<void> {
    const next = this.stateWriteQueue.then(() =>
      this.persistResourceState(item, id, apiName, properties, lifecyclePending, lifecycleActionPath)
    );
    this.stateWriteQueue = next.catch(() => undefined);
    return next;
  }

  private async persistResourceState(
    item: WorkItem,
    id: string,
    apiName: string | undefined,
    properties: Record<string, unknown>,
    lifecyclePending?: StateResourceEntry['lifecyclePending'],
    lifecycleActionPath?: string
  ): Promise<void> {
    const sanitized = safeIntent(properties) as Record<string, unknown>;
    const entry: StateResourceEntry = {
      kind: 'resource',
      type: item.type,
      name: item.name,
      declaredBy: this.manifest.useCase,
      id,
      apiName,
      propertiesHash: computePropertiesHash(sanitized),
      intentVersion: 1,
      lastAppliedIntent: safeIntent(apiProperties(properties)) as Record<string, unknown>,
      managedPaths: managedPaths(apiProperties(properties)),
      protected: properties.protect === true,
      outputs: {
        id,
        apiName,
        ...(this.outputs.get(item.key)?.dlApiName ? { dlApiName: this.outputs.get(item.key)!.dlApiName } : {}),
      },
      dependencies: this.graph.getDependencies(item.key),
      adopted:
        this.state.resources.find((r) => `${r.type}.${r.name}` === item.key)?.adopted ??
        (item.kind === 'adopt-clean' || item.kind === 'adopt-update'),
      lastAppliedAt: lifecyclePending ? undefined : new Date().toISOString(),
      lifecyclePending,
      lifecycleActionPath,
    };

    const index = this.state.resources.findIndex((r) => `${r.type}.${r.name}` === item.key);
    if (index === -1) {
      this.state.resources.push(entry);
    } else {
      this.state.resources[index] = entry;
    }

    this.state = await this.store.write(this.state);
    await this.journal.stateVersion(this.state.serial);
  }

  private seedOutputsFromState(): void {
    for (const entry of this.state.resources) {
      if (entry.id) {
        this.outputs.set(`${entry.type}.${entry.name}`, { id: entry.id, apiName: entry.apiName });
      }
    }
  }

  private buildWorkItems(): WorkItem[] {
    const blocks = resourceBlocksByKey(this.manifest);
    const items: WorkItem[] = [];

    const kindByKey = new Map<string, WorkItemKind>();
    for (const change of this.plan.changes) {
      if (change.action === 'no-op') continue;
      kindByKey.set(change.key, change.action === 'replace' ? 'create' : change.action);
    }

    const adoptedIdByKey = new Map<string, string>();
    for (const candidate of this.plan.adoptionCandidates) {
      kindByKey.set(candidate.key, candidate.cleanAdopt ? 'adopt-clean' : 'adopt-update');
      adoptedIdByKey.set(candidate.key, candidate.liveId);
    }

    for (const entry of this.state.resources.filter((r) => r.lifecyclePending)) {
      kindByKey.set(`${entry.type}.${entry.name}`, 'resume-lifecycle');
    }

    for (const [key, kind] of kindByKey) {
      const block = blocks.get(key);
      if (!block) continue;
      items.push({
        key,
        type: block.type,
        name: block.name,
        kind,
        block,
        adoptedId: adoptedIdByKey.get(key),
      });
    }

    return items;
  }
}
