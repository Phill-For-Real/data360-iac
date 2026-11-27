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
export type BlockKind = 'resource' | 'data';

export type ResourceBlock = {
  kind?: 'resource';
  type: string;
  name: string;
  properties: Record<string, unknown>;
  dependsOn?: string[];
};

export type DataBlock = {
  kind: 'data';
  type: string;
  name: string;
  lookup: Record<string, unknown>;
  dependsOn?: string[];
};

export type Block = ResourceBlock | DataBlock;

export function blockKind(block: Block): BlockKind {
  return block.kind ?? 'resource';
}

/** The `Type.name` key used both as a graph node id and as the body of a `${Type.name.field}` reference. */
export function blockKey(block: Pick<Block, 'type' | 'name'>): string {
  return `${block.type}.${block.name}`;
}

export type RawManifestFile = {
  useCase: string;
  dataSpace: string;
  resources: Block[];
};

export type LoadedManifest = {
  useCase: string;
  dataSpace: string;
  blocks: Block[];
};
