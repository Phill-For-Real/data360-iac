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
import { mkdir, open, rename, stat, link, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { convertObserved } from '../adapters/configuration.js';
import { AdapterContext } from '../adapters/types.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { loadManifest } from '../manifest/loader.js';
import { Block, RawManifestFile, blockKey } from '../manifest/types.js';
import { stableStringify, computePropertiesHash } from '../plan/properties-hash.js';
import { StateFile } from '../state/types.js';
import { Inventory, InventoryItem, directDmo } from './inventory.js';
export type ScaffoldReport = {
  version: 1;
  source: Inventory['source'];
  scope: string;
  selections: string[];
  dependencies: Array<{ key: string; managed: boolean }>;
  references: Array<{ key: string; path: string; target?: string; resolved: boolean }>;
  conversions: Array<{ key: string; changes: string[]; omittedFields: string[] }>;
  secretRequirements: Array<{ key: string; path: string; environmentVariable: string }>;
  omittedTrackedResources: string[];
  limits: string[];
  blockers: string[];
};
export type ScaffoldOptions = {
  inventory: Inventory;
  selectors: string[];
  useCase: string;
  dataSpace: string;
  ctx?: AdapterContext;
  state?: StateFile;
};
export function parseSelector(selector: string): { type: string; identifier: string } {
  const match = /^([A-Z][A-Za-z0-9]*):([^\s:]+(?:::[^\s:]+)?)$/.exec(selector);
  if (!match) throw new Error('Selectors must use Type:identifier syntax (rule identifiers may use policy::rule).');
  return { type: match[1], identifier: match[2] };
}
function aliases(item: InventoryItem): unknown[] {
  return [item.identity, item.observed.name, item.observed.apiName, item.observed.label, item.observed.developerName];
}
function lookup(item: InventoryItem): Record<string, unknown> {
  const o = item.observed;
  if (item.type === 'Connection') return { connectorType: o.connectorType, label: o.label };
  if (item.type === 'IdentityResolutionRuleset') return { label: o.label };
  if (item.type === 'CalculatedInsight') return { apiName: o.apiName };
  if (item.type === 'DataModelObjectMapping')
    return {
      sourceEntityDeveloperName: o.sourceEntityDeveloperName,
      targetEntityDeveloperName: o.targetEntityDeveloperName,
    };
  if (item.type === 'AccessPolicyRule') return { policyName: o.policyName, name: o.name };
  if (item.type === 'DataStream')
    return {
      name: o.name,
      connectionName:
        o.dataSource ??
        (o.connectorInfo as { connectorDetails?: { name?: string } } | undefined)?.connectorDetails?.name,
    };
  if (item.type === 'Segment') return { apiName: o.apiName ?? o.name };
  if (item.type === 'ActivationTarget') return { masterLabel: o.masterLabel };
  return { name: o.name };
}
function logicalName(item: InventoryItem): string {
  const raw = [item.observed.name, item.observed.apiName, item.observed.label, item.identity].find(
    (v): v is string => typeof v === 'string'
  )!;
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([^A-Za-z_])/, '_$1') || 'resource';
}
function visitKnownEntities(
  type: string,
  value: unknown,
  path = ''
): Array<{ path: string; type: string; identifier: string }> {
  if (!value || typeof value !== 'object') return [];
  const results: Array<{ path: string; type: string; identifier: string }> = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (typeof child === 'string') {
      const target =
        (type === 'IdentityResolutionRuleset' || type === 'Activation') &&
        ['entityName', 'objectApiName', 'secondaryDmo', 'objectName'].includes(key)
          ? 'DataModelObject'
          : undefined;
      if (target) results.push({ path: childPath, type: target, identifier: child });
    } else results.push(...visitKnownEntities(type, child, childPath));
  }
  return results;
}
function assign(value: Record<string, unknown>, path: string, replacement: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = value;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  cursor[parts[parts.length - 1]] = replacement;
}
function redact(value: unknown, key: string, report: ScaffoldReport, path = '', sensitive = false): unknown {
  const marker = (): unknown => {
    const environmentVariable = `DATA360_${key}_${path}`.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
    report.secretRequirements.push({ key, path, environmentVariable });
    return { $secret: { source: 'env', key: environmentVariable } };
  };
  if (Array.isArray(value)) return value.map((v, i) => redact(v, key, report, `${path}.${i}`, sensitive));
  if (!value || typeof value !== 'object') return sensitive ? marker() : value;
  const object = value as Record<string, unknown>;
  if ('$secret' in object) return marker();
  return Object.fromEntries(
    Object.entries(object).map(([field, child]) => [
      field,
      redact(
        child,
        key,
        report,
        path ? `${path}.${field}` : field,
        (sensitive && field !== 'name') || /password|token|credential|secret|authorization|accessKey/i.test(field)
      ),
    ])
  );
}
function sqlRelationships(
  expression: string,
  report: ScaffoldReport
): Array<{ path: string; type: string; identifier: string }> {
  // Tokenise without altering SQL. String literals and comments cannot become dependencies.
  const tokens =
    expression.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_]*|[^\s]/g) ?? [];
  const meaningful = tokens.filter((token) => !token.startsWith('--') && !token.startsWith('/*'));
  const result: Array<{ path: string; type: string; identifier: string }> = [];
  for (let index = 0; index < meaningful.length; index++) {
    if (!/^(FROM|JOIN)$/i.test(meaningful[index])) continue;
    const identifier = meaningful[index + 1];
    if (identifier === '(') continue; // Nested FROM/JOIN sources are visited separately.
    if (!identifier || !/^[A-Za-z_][A-Za-z0-9_]*__(dll|dlm|cio)$/.test(identifier)) {
      report.blockers.push('CalculatedInsight SQL source cannot be resolved by the verified dependency parser.');
      continue;
    }
    result.push({
      path: 'expression',
      type: identifier.endsWith('__dll')
        ? 'DataLakeObject'
        : identifier.endsWith('__cio')
        ? 'CalculatedInsight'
        : 'DataModelObject',
      identifier,
    });
  }
  return result;
}

function knownRelationships(
  item: InventoryItem,
  report: ScaffoldReport
): Array<{ path: string; type: string; identifier: string }> {
  const o = item.observed;
  const relationshipProperties = ['Activation', 'IdentityResolutionRuleset'].includes(item.type)
    ? convertObserved(item.type, o).properties
    : o;
  const relationships = visitKnownEntities(item.type, relationshipProperties);
  if (item.type === 'Activation') {
    const subject = relationshipProperties.activationTargetSubjectConfig as { developerName?: string } | undefined;
    if (subject?.developerName)
      relationships.push({
        path: 'activationTargetSubjectConfig.developerName',
        type: 'DataModelObject',
        identifier: subject.developerName,
      });
  }
  if (item.type === 'DataStream') {
    const connectionName =
      o.dataSource ?? (o.connectorInfo as { connectorDetails?: { name?: string } } | undefined)?.connectorDetails?.name;
    if (typeof connectionName === 'string')
      relationships.push({ path: 'connectionId', type: 'Connection', identifier: connectionName });
    else report.blockers.push('DataStream connection relationship is unavailable.');
  }
  if (item.type === 'DataModelObjectMapping') {
    for (const [path, type] of [
      ['sourceEntityDeveloperName', 'DataLakeObject'],
      ['targetEntityDeveloperName', 'DataModelObject'],
    ]) {
      if (typeof o[path] === 'string') relationships.push({ path, type, identifier: o[path] });
      else report.blockers.push('Mapping entity relationship is unavailable.');
    }
  }
  if (item.type === 'AccessPolicyRule' && typeof o.policyName === 'string')
    relationships.push({ path: 'policyName', type: 'AccessPolicy', identifier: o.policyName });
  if (item.type === 'Activation')
    for (const [path, type] of [
      ['segmentApiName', 'Segment'],
      ['activationTargetName', 'ActivationTarget'],
    ])
      if (typeof o[path] === 'string') relationships.push({ path, type, identifier: o[path] });
  if (item.type === 'CalculatedInsight' && typeof o.expression === 'string') {
    const expression = convertObserved('CalculatedInsight', o).properties.expression as string;
    report.limits.push(
      'CalculatedInsight SQL is preserved after one HTML decode. Dependency parsing supports plain FROM/JOIN entity identifiers; unsupported SQL sources block export.'
    );
    relationships.push(...sqlRelationships(expression, report));
  }
  return relationships;
}

type Dependency = { path: string; item: InventoryItem; output: string };
async function resolveDependencies(
  item: InventoryItem,
  inventory: Inventory,
  ctx: AdapterContext | undefined,
  report: ScaffoldReport,
  find: (type: string, identifier: string) => InventoryItem | undefined
): Promise<Dependency[]> {
  const relationships = knownRelationships(item, report);
  const dependencies: Array<{ path: string; item: InventoryItem; output: string }> = [];
  for (const relation of relationships) {
    // eslint-disable-next-line no-await-in-loop -- recursively resolve known DMO fields.
    if (relation.type === 'DataModelObject') await directDmo(inventory, relation.identifier, ctx);
    const ownedStreams =
      relation.type === 'DataLakeObject'
        ? inventory.items.filter(
            (i) =>
              i.type === 'DataStream' &&
              (i.observed.dataLakeObjectInfo as Record<string, unknown> | undefined)?.name === relation.identifier
          )
        : [];
    const dep = ownedStreams.length === 1 ? ownedStreams[0] : find(relation.type, relation.identifier);
    if (ownedStreams.length > 1) report.blockers.push('Ambiguous stream ownership of a DLO.');
    if (dep) {
      dependencies.push({
        path: relation.path,
        item: dep,
        output:
          dep.type === 'DataStream' && relation.type === 'DataLakeObject'
            ? 'dlApiName'
            : relation.path === 'connectionId'
            ? 'id'
            : 'apiName',
      });
    }
  }
  return dependencies;
}

// eslint-disable-next-line complexity -- validate each supported request shape without inventing missing fields.
function managedProperties(
  item: InventoryItem,
  key: string,
  dependencies: Dependency[],
  report: ScaffoldReport
): Record<string, unknown> {
  const conversion = convertObserved(item.type, item.observed);
  const properties = conversion.properties;
  report.conversions.push({ key, changes: conversion.conversions, omittedFields: conversion.omitted });
  report.blockers.push(...conversion.blockers.map((b) => `${key}: ${b}`));
  if (item.type === 'AccessPolicyRule')
    report.limits.push(`${key}: standalone deletion unsupported; exact reviewed parent cascade is required.`);
  if (item.type === 'DataStream') {
    const connector = properties.connectorInfo as Record<string, unknown> | undefined;
    if (!connector || !(connector.connectorDetails as Record<string, unknown> | undefined)?.events)
      report.blockers.push(
        `${key}: original IngestApi schema event name is not readable; do not infer it from generated DLO names.`
      );
  }
  const required: Record<string, string[]> = {
    Connection: ['name', 'label', 'connectorType'],
    DataStream: ['name', 'connectionId', 'datastreamType', 'connectorInfo', 'dataLakeObjectInfo', 'sourceFields'],
    CalculatedInsight: ['apiName', 'definitionType', 'expression'],
    IdentityResolutionRuleset: ['label', 'configurationType', 'rulesetId', 'matchRules', 'reconciliationRules'],
    Activation: [
      'name',
      'segmentApiName',
      'activationTargetName',
      'refreshType',
      'activationTargetSubjectConfig',
      'attributesConfig',
      'contactPointsConfig',
    ],
    DataModelObjectMapping: ['sourceEntityDeveloperName', 'targetEntityDeveloperName', 'fieldMapping'],
    AccessPolicy: ['name'],
    AccessPolicyRule: [
      'policyName',
      'name',
      'category',
      'effect',
      'action',
      'resourceScopeType',
      'principalScopeType',
      'ruleConsumer',
    ],
  };
  if (item.type === 'DataStream') {
    const dlo = properties.dataLakeObjectInfo as Record<string, unknown> | undefined;
    const schema = dlo?.dataLakeFieldInputRepresentations as Array<Record<string, unknown>> | undefined;
    if (
      !dlo ||
      !['name', 'label', 'category', 'dataspaceInfo'].every((field) => dlo[field] !== undefined) ||
      !Array.isArray(schema) ||
      !schema.length ||
      !schema.some((field) => field.isPrimaryKey === true) ||
      schema.some((field) => typeof field.name !== 'string' || typeof field.dataType !== 'string')
    )
      report.blockers.push(`${key}: complete DLO schema, primary key and Data Space configuration are required.`);
  }
  if (item.type === 'DataModelObjectMapping') {
    const fields = properties.fieldMapping;
    if (
      !Array.isArray(fields) ||
      fields.some(
        (field: Record<string, unknown>) =>
          typeof field.sourceFieldDeveloperName !== 'string' || typeof field.targetFieldDeveloperName !== 'string'
      )
    )
      report.blockers.push(`${key}: field mapping configuration is incomplete.`);
  }
  for (const field of required[item.type] ?? [])
    if (properties[field] === undefined && !dependencies.some((r) => r.path === field))
      report.blockers.push(`${key}: required ${field} cannot be reconstructed.`);
  return properties;
}

// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
function makeBlock(
  item: InventoryItem,
  names: Map<InventoryItem, string>,
  roots: Set<InventoryItem>,
  dependencyMap: Map<InventoryItem, Dependency[]>,
  options: ScaffoldOptions,
  report: ScaffoldReport
): Block {
  const name = names.get(item)!;
  const key = `${item.type}.${name}`;
  const managed =
    roots.has(item) && !(item.type === 'DataModelObject' && String(item.observed.name).startsWith('ssot__'));
  report.dependencies.push({ key, managed });
  if (
    options.state?.resources.some(
      (e) => e.type === item.type && e.id === item.identity && `${e.type}.${e.name}` !== key
    )
  )
    report.blockers.push(`${key}: already tracked at another address; selection cannot acquire ownership.`);
  let properties: Record<string, unknown>;
  if (managed) {
    properties = managedProperties(item, key, dependencyMap.get(item) ?? [], report);
  } else properties = lookup(item);
  for (const dependency of dependencyMap.get(item) ?? []) {
    const targetName = names.get(dependency.item);
    const target = targetName ? `${dependency.item.type}.${targetName}` : undefined;
    report.references.push({ key, path: dependency.path, target, resolved: !!target });
    // Lookup keys do not use manifest property paths; explicit graph edges retain dependencies.
    if (managed && target && dependency.path !== 'expression')
      assign(properties, dependency.path, '${' + target + '.' + dependency.output + '}');
  }
  if (managed && item.type === 'DataStream') {
    const connection = (dependencyMap.get(item) ?? []).find((d) => d.path === 'connectionId');
    if (connection) {
      const connector = properties.connectorInfo as { connectorDetails?: Record<string, unknown> };
      if (connector.connectorDetails)
        connector.connectorDetails.name = '${Connection.' + names.get(connection.item)! + '.apiName}';
    }
  }
  properties = redact(properties, key, report) as Record<string, unknown>;
  const dependsOn = [
    ...new Set((dependencyMap.get(item) ?? []).map((d) => `${d.item.type}.${names.get(d.item)!}`)),
  ].sort();
  return managed
    ? { kind: 'resource', type: item.type, name, properties, ...(dependsOn.length ? { dependsOn } : {}) }
    : { kind: 'data', type: item.type, name, lookup: properties, ...(dependsOn.length ? { dependsOn } : {}) };
}

// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
export async function scaffold(
  options: ScaffoldOptions
): Promise<{ manifest?: RawManifestFile; report: ScaffoldReport }> {
  const { inventory, selectors, ctx } = options;
  const report: ScaffoldReport = {
    version: 1,
    source: inventory.source,
    scope:
      'Selected subset of shared org/Data Space state. Selection proposes management; import/adoption approval is still required. Review every destroy action before applying a partial manifest.',
    selections: [...new Set(selectors)].sort(),
    dependencies: [],
    references: [],
    conversions: [],
    secretRequirements: [],
    omittedTrackedResources: [],
    limits: [...inventory.limits],
    blockers: [],
  };
  if (inventory.source.dataSpace && inventory.source.dataSpace !== options.dataSpace)
    report.blockers.push('Requested Data Space differs from known discovery source scope.');
  if (!options.useCase || !options.dataSpace) report.blockers.push('useCase and dataSpace must be nonempty.');
  const roots = new Set<InventoryItem>();
  const included = new Set<InventoryItem>();
  const find = (type: string, identifier: string): InventoryItem | undefined => {
    const matches = inventory.items.filter((i) => i.type === type && aliases(i).includes(identifier));
    const unique = [...new Map(matches.map((i) => [i.identity, i])).values()];
    if (
      matches.some((i) =>
        matches.some(
          (other) => i.identity === other.identity && stableStringify(i.observed) !== stableStringify(other.observed)
        )
      )
    ) {
      report.blockers.push(`${type}: conflicting observations for the same identity`);
      return undefined;
    }
    if (unique.length !== 1) {
      report.blockers.push(`${type}: ${unique.length ? 'ambiguous' : 'missing'} selection/dependency`);
      return undefined;
    }
    return unique[0];
  };
  for (const selector of report.selections) {
    let parsed: ReturnType<typeof parseSelector>;
    try {
      parsed = parseSelector(selector);
    } catch (error) {
      report.blockers.push((error as Error).message);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- direct standard DMO lookup never assumes collection absence.
    if (parsed.type === 'DataModelObject') await directDmo(inventory, parsed.identifier, ctx);
    const item = find(parsed.type, parsed.identifier);
    if (item) roots.add(item);
  }
  if (!report.selections.length) report.blockers.push('At least one --select is required.');
  const dependencyMap = new Map<InventoryItem, Array<{ path: string; item: InventoryItem; output: string }>>();
  const queue = [...roots];
  while (queue.length) {
    const item = queue.shift()!;
    if (included.has(item)) continue;
    included.add(item);
    // eslint-disable-next-line no-await-in-loop -- recursive dependencies are discovered before names are allocated.
    const dependencies = await resolveDependencies(item, inventory, ctx, report, find);
    queue.push(...dependencies.map((d) => d.item));
    dependencyMap.set(item, dependencies);
  }
  // A selected stream owns its materialised DLO. A separate DLO root cannot acquire it again.
  for (const item of [...included])
    if (
      item.type === 'DataLakeObject' &&
      [...included].some(
        (i) =>
          i.type === 'DataStream' &&
          (i.observed.dataLakeObjectInfo as Record<string, unknown> | undefined)?.name === item.observed.name
      )
    ) {
      if (roots.has(item)) report.blockers.push('Selected DLO is owned by a DataStream; select the stream instead.');
      included.delete(item);
    }
  const ordered = [...included].sort((a, b) => `${a.type}:${a.identity}`.localeCompare(`${b.type}:${b.identity}`));
  const names = new Map<InventoryItem, string>();
  for (const item of ordered) {
    const base = logicalName(item);
    const collision = ordered.filter((i) => i.type === item.type && logicalName(i) === base).length > 1;
    names.set(item, collision ? `${base}_${computePropertiesHash({ identity: item.identity }).slice(-10)}` : base);
  }
  const blocks: Block[] = [];
  for (const item of ordered) {
    blocks.push(makeBlock(item, names, roots, dependencyMap, options, report));
  }
  report.omittedTrackedResources = (options.state?.resources ?? [])
    .filter((e) => e.kind === 'resource' && !blocks.some((b) => blockKey(b) === `${e.type}.${e.name}`))
    .map((e) => `${e.type}.${e.name}`)
    .sort();
  const manifest: RawManifestFile = { useCase: options.useCase, dataSpace: options.dataSpace, resources: blocks };
  try {
    DependencyGraph.build({ useCase: manifest.useCase, dataSpace: manifest.dataSpace, blocks });
  } catch {
    report.blockers.push('Generated dependency graph is invalid (missing reference or cycle).');
  }
  report.limits = [...new Set([...report.limits, ...inventory.limits])].sort();
  report.blockers = [...new Set(report.blockers)].sort();
  return { manifest: report.blockers.length ? undefined : manifest, report };
}
export function manifestBytes(manifest: RawManifestFile): string {
  return JSON.stringify(JSON.parse(stableStringify(manifest)), null, 2) + '\n';
}
export async function publishScaffold(
  result: Awaited<ReturnType<typeof scaffold>>,
  out: string,
  overwrite = false
): Promise<{ manifestPath?: string; reportPath: string }> {
  const reportPath = `${out}.report.json`;
  for (const file of [out, reportPath]) {
    try {
      // eslint-disable-next-line no-await-in-loop -- verify both output destinations before publishing either.
      await stat(file);
      if (!overwrite) throw new Error('Output exists; explicit --overwrite is required.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir(dirname(out), { recursive: true });
  const publish = async (file: string, contents: string): Promise<void> => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (overwrite || file.endsWith('.validate.json')) await rename(temporary, file);
    else {
      await link(temporary, file);
      await unlink(temporary);
    }
  };
  let validationPath: string | undefined;
  if (result.manifest) {
    validationPath = `${out}.${randomUUID()}.validate.json`;
    await publish(validationPath, manifestBytes(result.manifest));
    try {
      const loaded = await loadManifest(validationPath);
      DependencyGraph.build(loaded);
    } catch {
      result.report.blockers.push('Static validation failed; no manifest published.');
      result.manifest = undefined;
      await unlink(validationPath);
      validationPath = undefined;
    }
  }
  await publish(reportPath, JSON.stringify(result.report, null, 2) + '\n');
  if (!result.manifest || !validationPath) return { reportPath };
  if (overwrite) await rename(validationPath, out);
  else {
    await link(validationPath, out);
    await unlink(validationPath);
  }
  return { manifestPath: out, reportPath };
}
