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
import { ManifestValidationError } from '../manifest/errors.js';
import { Block, blockKey, LoadedManifest } from '../manifest/types.js';
import { findReferences } from './references.js';

export type GraphNode = {
  key: string;
  block: Block;
};

/**
 * The resource reference graph: nodes are logical blocks (`Type.name`), edges point from a block
 * to every other block it depends on (via `${Type.name.field}` interpolation or explicit `dependsOn`).
 */
export class DependencyGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, Set<string>>();

  public static build(manifest: LoadedManifest): DependencyGraph {
    const graph = new DependencyGraph();

    for (const block of manifest.blocks) {
      const key = blockKey(block);
      if (graph.nodes.has(key)) {
        throw new ManifestValidationError(`Duplicate logical name "${key}"`);
      }
      graph.nodes.set(key, { key, block });
      graph.edges.set(key, new Set());
    }

    for (const block of manifest.blocks) {
      const key = blockKey(block);
      const dependencyValue = block.kind === 'data' ? block.lookup : block.properties;

      for (const ref of findReferences(dependencyValue)) {
        const refKey = `${ref.type}.${ref.name}`;
        if (!graph.nodes.has(refKey)) {
          throw new ManifestValidationError(`"${key}" references "${refKey}", which is not declared in the manifest`);
        }
        graph.edges.get(key)!.add(refKey);
      }

      for (const depKey of block.dependsOn ?? []) {
        if (!graph.nodes.has(depKey)) {
          throw new ManifestValidationError(
            `"${key}" has an explicit dependsOn entry "${depKey}", which is not declared in the manifest`
          );
        }
        graph.edges.get(key)!.add(depKey);
      }
    }

    graph.assertAcyclic();
    return graph;
  }

  public getNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  public getDependencies(key: string): string[] {
    return [...(this.edges.get(key) ?? [])];
  }

  /** Every key that directly depends on `key`. */
  public getDependents(key: string): string[] {
    const dependents: string[] = [];
    for (const [candidateKey, deps] of this.edges) {
      if (deps.has(key)) dependents.push(candidateKey);
    }
    return dependents;
  }

  /** Every key downstream of `key`, transitively. */
  public getTransitiveDependents(key: string): Set<string> {
    const result = new Set<string>();
    const stack = [key];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dependent of this.getDependents(current)) {
        if (!result.has(dependent)) {
          result.add(dependent);
          stack.push(dependent);
        }
      }
    }
    return result;
  }

  /** A topological ordering of all node keys (dependencies before dependents). */
  public topologicalOrder(): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (key: string): void => {
      if (visited.has(key)) return;
      visiting.add(key);
      for (const dep of this.getDependencies(key)) {
        visit(dep);
      }
      visiting.delete(key);
      visited.add(key);
      order.push(key);
    };

    for (const key of this.nodes.keys()) visit(key);
    return order;
  }

  private assertAcyclic(): void {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const visit = (key: string, path: string[]): void => {
      if (stack.has(key)) {
        const cycleStart = path.indexOf(key);
        const cycle = [...path.slice(cycleStart), key].join(' -> ');
        throw new ManifestValidationError(`Cycle detected in dependency graph: ${cycle}`);
      }
      if (visited.has(key)) return;

      stack.add(key);
      for (const dep of this.getDependencies(key)) {
        visit(dep, [...path, key]);
      }
      stack.delete(key);
      visited.add(key);
    };

    for (const key of this.nodes.keys()) visit(key, []);
  }
}
