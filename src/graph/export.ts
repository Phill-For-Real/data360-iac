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
import { DependencyGraph } from './dependency-graph.js';

export function toDot(graph: DependencyGraph): string {
  const lines = ['digraph data360 {'];
  for (const node of graph.getNodes()) {
    lines.push(`  "${node.key}";`);
  }
  for (const node of graph.getNodes()) {
    for (const dep of graph.getDependencies(node.key)) {
      lines.push(`  "${dep}" -> "${node.key}";`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

export type GraphJson = {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
};

export function toJson(graph: DependencyGraph): GraphJson {
  const nodes = graph.getNodes().map((n) => n.key);
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of graph.getNodes()) {
    for (const dep of graph.getDependencies(node.key)) {
      edges.push({ from: dep, to: node.key });
    }
  }
  return { nodes, edges };
}
