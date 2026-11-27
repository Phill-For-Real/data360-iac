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
import { Plan } from './types.js';

export function formatPlanSummary(plan: Plan): string {
  const lines: string[] = [];
  for (const blocker of plan.blockers ?? []) lines.push(`BLOCKED ${blocker.key}: ${blocker.code}: ${blocker.message}`);
  for (const cascade of plan.cascades ?? []) {
    lines.push(`Cascade ${cascade.parentKey}: ${cascade.scopeHash}`);
    for (const rule of cascade.rules)
      lines.push(`  ${rule.name}: ${rule.managedKey ?? 'untracked'}${rule.protected ? ' PROTECTED' : ''}`);
  }

  if (plan.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of plan.warnings) {
      lines.push(`  ${warning.key}: ${warning.message}`);
    }
    lines.push('');
  }

  if (plan.adoptionCandidates.length > 0) {
    lines.push('Adoption candidates:');
    for (const candidate of plan.adoptionCandidates) {
      const note = candidate.cleanAdopt ? 'clean adopt' : 'adopt, then update';
      lines.push(`  ${candidate.key} (${note})`);
    }
    lines.push('');
  }

  lines.push('Changes:');
  for (const change of plan.changes) {
    const warning = change.cascadeWarning?.length ? ` [downstream: ${change.cascadeWarning.join(', ')}]` : '';
    lines.push(`  ${change.action.padEnd(16)} ${change.key}${warning}`);
  }

  if (plan.destroys.length > 0) {
    lines.push('');
    lines.push('Destroys:');
    for (const destroy of plan.destroys) {
      lines.push(`  destroy          ${destroy.key}`);
    }
  }

  lines.push('');
  lines.push(
    `Summary: ${plan.summary.create} to create, ${plan.summary.update} to update, ` +
      `${plan.summary.replace} to replace, ${plan.summary.destroy} to destroy, ` +
      `${plan.summary.noOp} unchanged (${plan.summary.total} resources total).`
  );

  return lines.join('\n');
}

export function hasPendingChanges(plan: Plan): boolean {
  return (
    plan.summary.create > 0 ||
    plan.summary.update > 0 ||
    plan.summary.replace > 0 ||
    plan.summary.destroy > 0 ||
    plan.adoptionCandidates.length > 0
  );
}
