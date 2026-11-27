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
import { ResourceAdapter } from './types.js';
import { ConnectionAdapter } from './connection.js';
import { DataStreamAdapter } from './data-stream.js';
import { DataLakeObjectAdapter } from './data-lake-object.js';
import { DataModelObjectAdapter } from './data-model-object.js';
import { DataModelObjectMappingAdapter } from './data-model-object-mapping.js';
import { DataTransformAdapter } from './data-transform.js';
import { IdentityResolutionRulesetAdapter } from './identity-resolution-ruleset.js';
import { CalculatedInsightAdapter } from './calculated-insight.js';
import { SegmentAdapter } from './segment.js';
import { ActivationTargetAdapter } from './activation-target.js';
import { ActivationPlatformAdapter } from './activation-platform.js';
import { ActivationAdapter } from './activation.js';
import { TagAssignmentAdapter } from './tag-assignment.js';
import { ClassificationAssignmentAdapter } from './classification-assignment.js';
import { ObjectAccessGrantAdapter } from './object-access-grant.js';
import { AccessPolicyAdapter } from './access-policy.js';
import { AccessPolicyRuleAdapter } from './access-policy-rule.js';

const adapters: ResourceAdapter[] = [
  new ConnectionAdapter(),
  new DataStreamAdapter(),
  new DataLakeObjectAdapter(),
  new DataModelObjectAdapter(),
  new DataModelObjectMappingAdapter(),
  new DataTransformAdapter(),
  new IdentityResolutionRulesetAdapter(),
  new CalculatedInsightAdapter(),
  new SegmentAdapter(),
  new ActivationTargetAdapter(),
  new ActivationPlatformAdapter(),
  new ActivationAdapter(),
  new TagAssignmentAdapter(),
  new ClassificationAssignmentAdapter(),
  new ObjectAccessGrantAdapter(),
  new AccessPolicyAdapter(),
  new AccessPolicyRuleAdapter(),
];

const registry = new Map<string, ResourceAdapter>(adapters.map((a) => [a.type, a]));

export function getAdapter(resourceType: string): ResourceAdapter {
  const adapter = registry.get(resourceType);
  if (!adapter) {
    throw new Error(`No adapter registered for resource type "${resourceType}"`);
  }
  return adapter;
}

export function allAdapters(): ResourceAdapter[] {
  return [...registry.values()];
}
