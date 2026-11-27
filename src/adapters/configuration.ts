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
import { normalizeCalculatedInsight } from './calculated-insight.js';
export type Conversion = {
  properties: Record<string, unknown>;
  omitted: string[];
  blockers: string[];
  conversions: string[];
};
const FIELDS: Record<string, string[]> = {
  Connection: [
    'name',
    'label',
    'connectorType',
    'organizationId',
    'streamingAppType',
    'streamingAppSubType',
    'credentials',
    'parameters',
    'method',
  ],
  DataStream: [
    'name',
    'label',
    'connectionId',
    'datastreamType',
    'dataAccessMode',
    'connectorInfo',
    'dataLakeObjectInfo',
    'sourceFields',
    'mappings',
    'refreshConfig',
    'advancedAttributes',
  ],
  DataLakeObject: [
    'name',
    'label',
    'category',
    'dataspaceInfo',
    'dataLakeFieldInputRepresentations',
    'orgUnitIdentifierFieldName',
    'recordModifiedFieldName',
  ],
  DataModelObject: ['name', 'label', 'category', 'fields', 'dataSpaceName'],
  DataModelObjectMapping: ['sourceEntityDeveloperName', 'targetEntityDeveloperName', 'fieldMapping', 'dataSpaceName'],
  CalculatedInsight: [
    'apiName',
    'definitionType',
    'dataSpaceName',
    'expression',
    'description',
    'displayName',
    'publishScheduleInterval',
    'publishScheduleStartDateTime',
  ],
  IdentityResolutionRuleset: [
    'label',
    'configurationType',
    'rulesetId',
    'objectApiName',
    'secondaryDmo',
    'dataSpaceName',
    'matchRules',
    'reconciliationRules',
    'doesRunAutomatically',
    'description',
  ],
  Activation: [
    'name',
    'description',
    'dataSpaceName',
    'segmentApiName',
    'activationTargetName',
    'refreshType',
    'activationTargetSubjectConfig',
    'attributesConfig',
    'contactPointsConfig',
    'directDmoFiltersConfig',
    'relatedDmoFiltersConfig',
  ],
  AccessPolicy: ['name', 'label', 'description'],
  AccessPolicyRule: [
    'policyName',
    'name',
    'label',
    'category',
    'effect',
    'action',
    'resourceScopeType',
    'principalScopeType',
    'principalAuthenticationLevel',
    'resourceDomains',
    'resourceTransform',
    'resourceTransformArguments',
    'transformPrecedence',
    'ruleConsumer',
  ],
  Segment: [
    'name',
    'apiName',
    'segmentOnApiName',
    'segmentType',
    'dataSpaceName',
    'includeDbt',
    'excludeDbt',
    'publishScheduleInfo',
    'publishInterval',
    'description',
  ],
  ActivationTarget: ['name', 'label', 'dataSpaceName', 'platformType', 'connector'],
  DataTransform: ['name', 'label', 'type', 'definition', 'dataSpaceName'],
};
export const SCAFFOLD_TYPES = [
  'Connection',
  'DataStream',
  'DataModelObject',
  'DataModelObjectMapping',
  'CalculatedInsight',
  'IdentityResolutionRuleset',
  'Activation',
  'AccessPolicy',
  'AccessPolicyRule',
];
function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}
function observedPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined,
      value
    );
}
function pick(value: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
function pathConfig(value: unknown, preserveUnknown = false): unknown {
  if (!value || typeof value !== 'object') return value;
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.configs)) throw new Error('Unsupported Activation queryPathConfig');
  return {
    ...(preserveUnknown ? config : {}),
    configs: config.configs.map((c: Record<string, unknown>) => {
      if (c.queryPaths) return c;
      if (Array.isArray(c.queryPath)) return { ...(preserveUnknown ? c : {}), queryPaths: { queryPath: c.queryPath } };
      throw new Error('Unsupported Activation query path wrapper');
    }),
  };
}
function attributes(value: unknown, preserveUnknown = false): unknown {
  if (!value || typeof value !== 'object') throw new Error('Unreadable Activation attributes');
  const config = value as Record<string, unknown>;
  const list = config.attributes ?? config.contactPointFields;
  if (!Array.isArray(list)) throw new Error('Unsupported Activation field representation');
  return {
    ...(preserveUnknown ? config : {}),
    attributes: list.map((a: Record<string, unknown>) => {
      const result = {
        ...(preserveUnknown ? a : {}),
        ...pick(a, [
          'name',
          'label',
          'entityName',
          'dataSourceType',
          'referenceAttributeName',
          'preferredName',
          'source',
          'type',
          'queryPathConfig',
        ]),
      };
      if (typeof result.name !== 'string') throw new Error('Activation attribute name is unavailable');
      if (result.queryPathConfig) result.queryPathConfig = pathConfig(result.queryPathConfig, preserveUnknown);
      return result;
    }),
  };
}
// eslint-disable-next-line complexity -- keep distinct safety outcomes and adapter contracts explicit.
export function convertObserved(type: string, observed: Record<string, unknown>, forComparison = false): Conversion {
  const fields = FIELDS[type];
  const result: Conversion = { properties: {}, omitted: [], blockers: [], conversions: [] };
  if (!fields) {
    result.blockers.push(`Unsupported scaffold type ${type}`);
    return result;
  }
  const raw = structuredClone(type === 'CalculatedInsight' ? normalizeCalculatedInsight(observed) : observed);
  try {
    if (type === 'IdentityResolutionRuleset' && raw.configurationType === 'account') {
      raw.configurationType = 'Account';
      result.conversions.push('Verified Account configuration type casing');
    }
    if (type === 'DataModelObjectMapping') {
      raw.fieldMapping = raw.fieldMapping ?? raw.fieldMappings;
      if (raw.dataspace !== undefined) raw.dataSpaceName = raw.dataspace;
      result.conversions.push('fieldMappings mapped to fieldMapping');
    }
    if (type === 'DataStream') {
      raw.datastreamType = raw.datastreamType ?? raw.dataStreamType;
      if (Array.isArray(raw.sourceFields))
        raw.sourceFields = raw.sourceFields.map((f: Record<string, unknown>) => ({
          ...(forComparison ? f : {}),
          ...pick(f, ['name', 'dataType']),
          ...(f.datatype ? { dataType: f.datatype } : {}),
        }));
      const dlo = raw.dataLakeObjectInfo as Record<string, unknown> | undefined;
      if (dlo) {
        raw.dataLakeObjectInfo = {
          ...(forComparison ? dlo : {}),
          ...pick(dlo, [
            'name',
            'label',
            'category',
            'dataspaceInfo',
            'eventDateTimeFieldName',
            'recordModifiedFieldName',
            'orgUnitIdentifierFieldName',
          ]),
        };
        if (dlo.dataSpaceInfo !== undefined)
          (raw.dataLakeObjectInfo as Record<string, unknown>).dataspaceInfo = dlo.dataSpaceInfo;
        const fieldsInput = dlo.dataLakeFieldInputRepresentations ?? dlo.dataLakeFieldInfoRepresentation;
        if (Array.isArray(fieldsInput))
          (raw.dataLakeObjectInfo as Record<string, unknown>).dataLakeFieldInputRepresentations = fieldsInput.map(
            (f) => ({
              ...(forComparison ? (f as Record<string, unknown>) : {}),
              ...pick(f as Record<string, unknown>, ['name', 'label', 'dataType', 'isPrimaryKey']),
            })
          );
      }
      if (raw.datastreamType === 'INGESTAPI') raw.datastreamType = 'INGEST_API';
      result.conversions.push('DataStream response fields mapped to create fields; recordId remains output only');
    }
    if (type === 'Activation') {
      if (raw.attributesConfig) raw.attributesConfig = attributes(raw.attributesConfig, forComparison);
      const contacts = raw.contactPointsConfig as { contactPoints?: Array<Record<string, unknown>> } | undefined;
      if (contacts) {
        if (!Array.isArray(contacts.contactPoints)) throw new Error('Unsupported Activation contactPointsConfig');
        raw.contactPointsConfig = {
          contactPoints: contacts.contactPoints.map((c) => {
            const contact = {
              ...(forComparison ? c : {}),
              ...pick(c, ['type', 'entityName', 'attributesConfig', 'queryPathConfig', 'sourcesConfig']),
            };
            if (c.contactPointEntityName !== undefined) contact.entityName = c.contactPointEntityName;
            contact.attributesConfig = attributes(c.attributesConfig ?? c.fieldConfig, forComparison);
            if (c.queryPathConfig) contact.queryPathConfig = pathConfig(c.queryPathConfig, forComparison);
            if (c.sourceConfig !== undefined) contact.sourcesConfig = c.sourceConfig;
            if (!contact.entityName) throw new Error('Activation contact point entity is unavailable');
            return contact;
          }),
        };
      }
      result.conversions.push('Activation entityName, attributes, queryPaths and sourcesConfig request wrappers');
    }
    result.properties = pick(raw, fields);
    if (type === 'Connection' && raw.connectorType !== 'IngestApi')
      result.blockers.push('Only IngestApi Connection management has a tested conversion contract.');
    if (
      type === 'DataStream' &&
      (raw.connectorInfo as Record<string, unknown> | undefined)?.connectorType !== 'IngestApi'
    )
      result.blockers.push('Only IngestApi DataStream management has a tested conversion contract.');
    if (type === 'DataModelObject')
      result.blockers.push(
        'DataModelObject scaffolding supports read-only lookup blocks; custom managed configuration is not verified.'
      );
    if (!SCAFFOLD_TYPES.includes(type)) result.blockers.push(`Unsupported managed shape ${type}`);
    result.omitted = leafPaths(observed)
      .filter((path) => observedPath(result.properties, path) === undefined)
      .sort();
  } catch (error) {
    result.blockers.push((error as Error).message);
  }
  return result;
}
// Comparable observations preserve pass-through configuration and runtime outputs. Only
// verified response/request transformations are applied, separately from scaffold filtering.
export function comparable(type: string, live: Record<string, unknown>): Record<string, unknown> {
  if (type === 'Activation' || type === 'DataStream' || type === 'DataModelObjectMapping')
    return { ...live, ...convertObserved(type, live, true).properties };
  if (type === 'IdentityResolutionRuleset' && live.configurationType === 'account')
    return { ...live, configurationType: 'Account' };
  return live;
}
export function unknownObservationPaths(type: string): string[] {
  if (type === 'Connection') return ['name', 'credentials'];
  if (type === 'DataStream')
    return ['connectionId', 'name', 'label', 'dataLakeObjectInfo.name', 'connectorInfo.connectorDetails'];
  return [];
}

/** A PUT must preserve the complete readable declarable configuration. Never use a raw GET body. */
export function safePutProperties(
  type: string,
  observed: Record<string, unknown>,
  desired: Record<string, unknown>
): Record<string, unknown> {
  const conversion = convertObserved(type, observed);
  const required =
    type === 'Activation'
      ? [
          'name',
          'segmentApiName',
          'activationTargetName',
          'refreshType',
          'activationTargetSubjectConfig',
          'attributesConfig',
          'contactPointsConfig',
        ]
      : [
          'name',
          'policyName',
          'category',
          'effect',
          'action',
          'resourceScopeType',
          'principalScopeType',
          'ruleConsumer',
        ];
  const merge = (base: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...base };
    for (const [key, value] of Object.entries(changes))
      result[key] =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        base[key] &&
        typeof base[key] === 'object' &&
        !Array.isArray(base[key])
          ? merge(base[key] as Record<string, unknown>, value as Record<string, unknown>)
          : value;
    return result;
  };
  const properties = merge(conversion.properties, desired);
  if (conversion.blockers.length || required.some((field) => properties[field] === undefined))
    throw new Error('Safe PUT payload cannot be reconstructed from complete readable declarable configuration.');
  return properties;
}
