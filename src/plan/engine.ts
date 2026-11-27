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
import { AdapterContext, AdapterReadResult } from '../adapters/types.js';
import { getAdapter } from '../adapters/registry.js';
import { comparable, unknownObservationPaths, safePutProperties } from '../adapters/configuration.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { blockKey, LoadedManifest } from '../manifest/types.js';
import { StateFile } from '../state/types.js';
import { resolveReferences, ResolvedOutputs } from '../execution/resolve-references.js';
import { reviewDeletions } from '../execution/deletion-safety.js';
import { safeIntent } from './safe-intent.js';
import { computePropertiesHash } from './properties-hash.js';
import { apiProperties, compareManaged } from './diff.js';
import { Plan, PlannedChange, PlanningWarning, SafetyBlocker, AdoptionCandidate } from './types.js';

export type PlanEngineOptions = {
  manifest: LoadedManifest;
  graph: DependencyGraph;
  state: StateFile;
  ctx: AdapterContext;
};
export class PlanEngine {
  public constructor(private readonly options: PlanEngineOptions) {}
  // eslint-disable-next-line complexity -- planning resolves ordered observations and intent before classification.
  public async compute(): Promise<Plan> {
    const { manifest, graph, state, ctx } = this.options;
    const outputs: ResolvedOutputs = new Map();
    const liveByKey = new Map<string, Record<string, unknown>>();
    const warnings: PlanningWarning[] = [];
    for (const entry of state.resources.filter((resource) => resource.lifecyclePending)) {
      warnings.push({
        key: `${entry.type}.${entry.name}`,
        type: entry.type,
        name: entry.name,
        message: `Pending lifecycle ${String(
          entry.lifecyclePending
        )}: apply resumes by recorded identity; uncertain actions are not replayed.`,
      });
    }

    const blockers: SafetyBlocker[] = [];
    const changes: PlannedChange[] = [];
    const adoptionCandidates: AdoptionCandidate[] = [];
    for (const entry of state.resources) {
      const key = `${entry.type}.${entry.name}`;
      outputs.set(key, { ...entry.outputs, id: entry.id, apiName: entry.apiName });
      try {
        // eslint-disable-next-line no-await-in-loop -- bounded reads.
        const live = entry.id ? await getAdapter(entry.type).read(ctx, entry.id) : undefined;
        if (live) {
          liveByKey.set(key, comparable(entry.type, live.properties));
          outputs.set(key, { ...live.properties, id: live.id, apiName: live.apiName });
        } else {
          blockers.push({
            key,
            code: 'UNKNOWN_OBSERVATION',
            message:
              'Tracked resource returned no authoritative comparable configuration; retain state and reconcile its identity.',
          });
        }
      } catch {
        warnings.push({ key, type: entry.type, name: entry.name, message: 'Live read failed; outcome unknown.' });
        blockers.push({
          key,
          code: 'UNKNOWN_OBSERVATION',
          message: 'Cannot safely plan against an unreadable tracked resource.',
        });
      }
    }
    const blocks = new Map(manifest.blocks.map((b) => [blockKey(b), b]));
    for (const key of graph.topologicalOrder()) {
      const block = blocks.get(key)!;
      const adapter = getAdapter(block.type);
      const entry = state.resources.find((e) => `${e.type}.${e.name}` === key);
      let desired: Record<string, unknown>;
      try {
        desired = resolveReferences(
          block.kind === 'data' ? block.lookup : apiProperties(block.properties),
          outputs
        ) as Record<string, unknown>;
      } catch {
        if (block.kind !== 'data' && !entry) {
          changes.push({ key, type: block.type, name: block.name, action: 'create' });
          continue;
        }
        blockers.push({
          key,
          code: 'UNRESOLVED_REFERENCE',
          message: 'A required live dependency output is unavailable.',
        });
        continue;
      }
      if (block.kind === 'data') {
        try {
          // eslint-disable-next-line no-await-in-loop -- graph order.
          const live = await adapter.lookup(ctx, desired);
          if (!live) throw new Error('missing');
          outputs.set(key, { ...live.properties, id: live.id, apiName: live.apiName });
        } catch {
          blockers.push({
            key,
            code: 'MISSING_DEPENDENCY',
            message: 'Read-only dependency could not be resolved unambiguously.',
          });
        }
        continue;
      }
      if (entry) {
        if (!entry.intentVersion)
          warnings.push({
            key,
            type: block.type,
            name: block.name,
            message:
              'Legacy state: historical managed-field ownership is unknown; reviewed adoption/apply establishes a baseline.',
          });
        const observed = liveByKey.get(key);
        if (!observed) {
          changes.push({ key, type: block.type, name: block.name, action: 'no-op' });
          continue;
        }
        const previous = entry.lastAppliedIntent
          ? (resolveReferences(apiProperties(entry.lastAppliedIntent), outputs) as Record<string, unknown>)
          : undefined;
        const comparison = compareManaged(
          desired,
          observed,
          adapter.fieldClassification,
          previous,
          adapter.clearablePaths,
          unknownObservationPaths(block.type),
          adapter.setLikePaths
        );
        for (const message of comparison.blockers) blockers.push({ key, code: 'UNSUPPORTED_FIELD_REMOVAL', message });
        if (comparison.action === 'update-in-place' && ['Activation', 'AccessPolicyRule'].includes(block.type)) {
          try {
            safePutProperties(block.type, observed, desired);
          } catch {
            blockers.push({
              key,
              code: 'UNSAFE_PUT',
              message: 'Complete safe replacement payload cannot be reconstructed.',
            });
          }
        }
        changes.push({ key, type: block.type, name: block.name, action: comparison.action });
      } else {
        let live: AdapterReadResult;
        try {
          // eslint-disable-next-line no-await-in-loop -- graph order, never resolves secrets.
          live = await adapter.lookup(ctx, desired);
        } catch {
          warnings.push({
            key,
            type: block.type,
            name: block.name,
            message: 'Adoption lookup failed; create is not authorised until scope is known.',
          });
          blockers.push({ key, code: 'UNKNOWN_ADOPTION_SCOPE', message: 'Lookup failed or is ambiguous.' });
        }
        if (live) {
          if (state.resources.some((r) => r.type === block.type && r.id === live.id))
            blockers.push({
              key,
              code: 'OWNED_ELSEWHERE',
              message: 'This remote resource is already tracked at another address.',
            });
          const comparison = compareManaged(
            desired,
            comparable(block.type, live.properties),
            adapter.fieldClassification,
            undefined,
            adapter.clearablePaths,
            unknownObservationPaths(block.type),
            adapter.setLikePaths
          );
          for (const message of comparison.blockers) blockers.push({ key, code: 'UNSUPPORTED_CLEAR', message });
          if (comparison.action === 'replace')
            blockers.push({
              key,
              code: block.type === 'AccessPolicyRule' ? 'UNSUPPORTED_DELETE' : 'ADOPTION_REPLACEMENT_REVIEW_REQUIRED',
              message:
                'Adoption requires replacement of immutable configuration. Import after ownership review, then generate a reviewed deletion/replacement plan; no implicit delete is authorised.',
            });
          if (comparison.action !== 'no-op' && ['Activation', 'AccessPolicyRule'].includes(block.type)) {
            try {
              safePutProperties(block.type, comparable(block.type, live.properties), desired);
            } catch {
              blockers.push({
                key,
                code: 'UNSAFE_PUT',
                message: 'Complete safe adoption-update payload cannot be reconstructed.',
              });
            }
          }

          adoptionCandidates.push({
            key,
            type: block.type,
            name: block.name,
            liveId: live.id,
            cleanAdopt: comparison.action === 'no-op',
          });
          outputs.set(key, { ...live.properties, id: live.id, apiName: live.apiName });
        } else changes.push({ key, type: block.type, name: block.name, action: 'create' });
      }
    }
    const managedKeys = new Set(manifest.blocks.filter((b) => b.kind !== 'data').map(blockKey));
    const destroys: PlannedChange[] = state.resources
      .filter((e) => e.kind === 'resource' && !managedKeys.has(`${e.type}.${e.name}`))
      .map((e) => ({ key: `${e.type}.${e.name}`, type: e.type, name: e.name, action: 'replace' }));
    const deletionKeys = new Set([...destroys, ...changes.filter((c) => c.action === 'replace')].map((c) => c.key));
    const deletion = await reviewDeletions(
      state,
      deletionKeys,
      ctx,
      new Set(manifest.blocks.filter((b) => b.kind !== 'data' && b.properties.protect === true).map(blockKey))
    );
    blockers.push(...deletion.blockers);
    for (const change of changes)
      if (change.action === 'replace') change.cascadeWarning = [...graph.getTransitiveDependents(change.key)];
    return {
      version: 2,
      identity: {
        orgId: state.orgFingerprint.orgId,
        dataSpace: state.orgFingerprint.dataSpace,
        lineage: state.lineage,
        serial: state.serial,
        manifestHash: computePropertiesHash(safeIntent(manifest) as Record<string, unknown>),
      },
      changes,
      destroys,
      adoptionCandidates,
      warnings,
      blockers,
      cascades: deletion.cascades,
      summary: {
        create: changes.filter((c) => c.action === 'create').length,
        update: changes.filter((c) => c.action === 'update-in-place').length,
        replace: changes.filter((c) => c.action === 'replace').length,
        destroy: destroys.length,
        noOp: changes.filter((c) => c.action === 'no-op').length,
        total: changes.length + adoptionCandidates.length,
      },
    };
  }
}
