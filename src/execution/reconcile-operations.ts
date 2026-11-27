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
import { computePropertiesHash } from '../plan/properties-hash.js';
import { AdapterContext, hasAsyncJob } from '../adapters/types.js';
import { getAdapter } from '../adapters/registry.js';
import { comparable, unknownObservationPaths } from '../adapters/configuration.js';
import { OperationJournal, OperationRecord } from '../state/journal.js';
import { StateFile } from '../state/types.js';
import { StateStore } from '../state/store.js';
import { compareManaged, managedPaths } from '../plan/diff.js';
import { resolveReferences, ResolvedOutputs } from './resolve-references.js';
export type ReconciliationResult = {
  operationId: string;
  key: string;
  outcome: 'committed' | 'unknown' | 'conflict';
  reason: string;
  candidateIds?: string[];
  confirmedIdentity?: { id: string; apiName?: string; dlApiName?: string };
};
/** Read-only remote recovery; never invokes adapter create/update/delete or actions. */
// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
export async function reconcileOperations(
  journal: OperationJournal,
  store: StateStore,
  initial: StateFile,
  ctx: AdapterContext
): Promise<ReconciliationResult[]> {
  let state = initial;
  const results: ReconciliationResult[] = [];
  const pending = await journal.pending();
  for (const initialRecord of pending) {
    // eslint-disable-next-line no-await-in-loop -- use updated state serial after our own repairs.
    const record = (await journal.read()).find((r) => r.operationId === initialRecord.operationId)!;
    if (record.phase === 'prepared') {
      // Durable dispatch was never reached, so this specific request was not sent.
      // eslint-disable-next-line no-await-in-loop -- safe local rejection of an undispatched intent.
      await journal.phase(record.operationId, 'rejected', { reconciliation: 'Prepared intent was never dispatched.' });
      results.push({
        operationId: record.operationId,
        key: record.key,
        outcome: 'committed',
        reason: 'Request was never dispatched; original intent can be reviewed again.',
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- state repair and ordered operation evidence.
    const result = await reconcileRecord(record, state, ctx);
    results.push(result);
    if (result.outcome !== 'committed') continue;
    if (record.operation === 'delete') {
      // Parent cascades require the recorded reviewed inventory in destroy, not generic removal.
      if (record.type === 'AccessPolicy') {
        result.outcome = 'unknown';
        result.reason = 'Resume destroy with its exact recorded cascade review.';
        continue;
      }
      state.resources = state.resources.filter((e) => `${e.type}.${e.name}` !== record.key);
    } else if (record.operation === 'action') {
      if (!state.resources.some((e) => `${e.type}.${e.name}` === record.key && e.id === record.remoteId)) {
        result.outcome = 'conflict';
        result.reason = 'Action acknowledgement lacks its original resource tracking; restore state before recovery.';
        continue;
      }
      state.resources = state.resources.map((e) =>
        `${e.type}.${e.name}` === record.key
          ? { ...e, lifecyclePending: 'action-confirmed' as const, lifecycleActionPath: record.path }
          : e
      );
    } else if (!record.path.endsWith('/schema')) {
      const [type, name] = record.key.split('.');
      const old = state.resources.find((e) => `${e.type}.${e.name}` === record.key);
      const id =
        record.responseIdentifiers?.recordId ??
        record.responseIdentifiers?.id ??
        record.responseIdentifiers?.apiName ??
        record.remoteId;
      if (!id) {
        result.outcome = 'unknown';
        result.reason = 'A confirmed remote identity is required for state repair.';
        continue;
      }
      const entry = {
        ...old,
        type,
        name,
        kind: 'resource' as const,
        id,
        apiName: result.confirmedIdentity?.apiName ?? record.responseIdentifiers?.apiName,
        propertiesHash: computePropertiesHash(record.intent),
        protected: old?.protected ?? record.protected,
        adopted: old?.adopted ?? false,
        outputs: result.confirmedIdentity,
        dependencies: old?.dependencies ?? record.dependencies ?? [],
        intentVersion: 1 as const,
        lastAppliedIntent: record.intent,
        managedPaths: managedPaths(record.intent),
        lifecyclePending:
          old?.lastAppliedAt && !old.lifecyclePending
            ? undefined
            : old?.lifecyclePending ?? (hasAsyncJob(getAdapter(type)) ? ('ready' as const) : undefined),
      };
      state.resources = [...state.resources.filter((e) => `${e.type}.${e.name}` !== record.key), entry];
    }
    // eslint-disable-next-line no-await-in-loop -- local durable repair must precede journal completion.
    state = await store.write(state);
    // eslint-disable-next-line no-await-in-loop -- record repaired serial across pending operations.
    await journal.stateVersion(state.serial);
    // eslint-disable-next-line no-await-in-loop -- final journal commit, never replay a confirmed write.
    await journal.phase(record.operationId, 'committed', { reconciliation: result.reason });
  }
  return results;
}
// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
async function reconcileRecord(
  record: OperationRecord,
  state: StateFile,
  ctx: AdapterContext
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    operationId: record.operationId,
    key: record.key,
    outcome: 'unknown',
    reason: 'Remote outcome remains unknown; retain journal and tracking. No replay is authorised.',
  };
  if (record.stateSerial !== state.serial && record.phase !== 'confirmed')
    return {
      ...result,
      outcome: 'conflict',
      reason: 'State version differs from recorded dispatch; review original intent before recovery.',
    };
  if (record.operation === 'action')
    return record.phase === 'confirmed'
      ? {
          ...result,
          outcome: 'committed',
          reason: 'Recorded action acknowledgement; repair checkpoint without replay.',
        }
      : { ...result, reason: 'Uncertain action has no verified completion evidence contract; do not repeat run-now.' };
  if (record.path.endsWith('/schema'))
    return record.phase === 'confirmed'
      ? {
          ...result,
          outcome: 'committed',
          reason: 'Schema acknowledgement retained independently of later stream creation.',
        }
      : result;
  const adapter = getAdapter(record.type);
  const id =
    record.responseIdentifiers?.recordId ??
    record.responseIdentifiers?.id ??
    record.responseIdentifiers?.apiName ??
    record.remoteId;
  if (!id) {
    const candidates = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      ctx.onJobPoll?.(`Reconciling ${record.key}: read ${attempt + 1}/3`);
      try {
        // eslint-disable-next-line no-await-in-loop -- bounded original-intent lookup; no replay after an empty result.
        const candidate = await adapter.lookup(ctx, record.lookup ?? record.intent);
        if (candidate) candidates.add(candidate.id);
      } catch {
        return {
          ...result,
          reason: 'Scoped candidate lookup is ambiguous, incomplete or unavailable; no identity selected.',
        };
      }
    }
    return {
      ...result,
      candidateIds: [...candidates].sort(),
      reason:
        'No confirmed identity. Candidate labels cannot prove ownership; verify an original-operation identity explicitly without recreating.',
    };
  }
  try {
    if (record.operation === 'delete') {
      const absence = adapter.observeDeletion
        ? await adapter.observeDeletion(ctx, id)
        : await observeMember(ctx, record.path);
      return absence.outcome === 'absent'
        ? { ...result, outcome: 'committed', reason: 'Authoritative member absence confirmed.' }
        : result;
    }
    const live = await adapter.read(ctx, id);
    if (!live) return result;
    const outputs: ResolvedOutputs = new Map(
      state.resources.map((e) => [`${e.type}.${e.name}`, { ...e.outputs, id: e.id, apiName: e.apiName }])
    );
    const desired = record.lookup ?? (resolveReferences(record.intent, outputs) as Record<string, unknown>);
    const comparison = compareManaged(
      desired,
      comparable(record.type, live.properties),
      adapter.fieldClassification,
      desired,
      adapter.clearablePaths,
      unknownObservationPaths(record.type)
    );
    return comparison.action === 'no-op' && !comparison.blockers.length
      ? {
          ...result,
          outcome: 'committed',
          reason: 'Identified resource matches the recorded managed intent.',
          confirmedIdentity: {
            id: live.id,
            apiName: live.apiName,
            ...(typeof live.properties.dlApiName === 'string' ? { dlApiName: live.properties.dlApiName } : {}),
          },
        }
      : {
          ...result,
          outcome: 'conflict',
          reason: 'Identified resource differs from recorded intent; no replay or silent adoption.',
        };
  } catch {
    return result;
  }
}
async function observeMember(ctx: AdapterContext, path: string): Promise<{ outcome: 'absent' | 'unknown' }> {
  try {
    await ctx.client.request({ method: 'GET', path: path.split('?')[0] });
    return { outcome: 'unknown' };
  } catch (error) {
    return { outcome: (error as { statusCode?: number }).statusCode === 404 ? 'absent' : 'unknown' };
  }
}
