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
import { ResourceBlock } from '../manifest/types.js';
import { ChangeAction } from '../plan/types.js';

export type WorkItemKind =
  | 'create'
  | 'update-in-place'
  | 'replace'
  | 'adopt-clean'
  | 'adopt-update'
  | 'resume-lifecycle';

export type WorkItem = {
  key: string;
  type: string;
  name: string;
  kind: WorkItemKind;
  block: ResourceBlock;
  /** Only set for 'adopt-clean' / 'adopt-update': the id already discovered live in the org. */
  adoptedId?: string;
};

export function changeActionToKind(action: ChangeAction): WorkItemKind | undefined {
  if (action === 'no-op') return undefined;
  return action;
}
