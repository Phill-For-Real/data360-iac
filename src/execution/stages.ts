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
export type Stage = {
  number: number;
  name: string;
  types: string[];
};

export const STAGES: Stage[] = [
  { number: 1, name: 'Connections', types: ['Connection'] },
  { number: 2, name: 'Ingestion', types: ['DataStream', 'DataLakeObject'] },
  { number: 3, name: 'Data Model', types: ['DataModelObject', 'DataModelObjectMapping', 'DataTransform'] },
  { number: 4, name: 'Intelligence', types: ['IdentityResolutionRuleset', 'CalculatedInsight'] },
  {
    number: 5,
    name: 'Governance',
    types: ['AccessPolicy', 'AccessPolicyRule', 'TagAssignment', 'ClassificationAssignment', 'ObjectAccessGrant'],
  },
  { number: 6, name: 'Segmentation', types: ['Segment'] },
  { number: 7, name: 'Activation', types: ['ActivationTarget', 'ActivationPlatform', 'Activation'] },
];

const stageByType = new Map<string, Stage>(STAGES.flatMap((stage) => stage.types.map((type) => [type, stage])));

export function stageForType(resourceType: string): Stage {
  const stage = stageByType.get(resourceType);
  if (!stage) {
    throw new Error(`No stage defined for resource type "${resourceType}"`);
  }
  return stage;
}
