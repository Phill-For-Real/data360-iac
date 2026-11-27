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
import { FakeConnectRestClient } from '../../src/connect-rest/client.js';
import { collectionPath, memberPath, withQuery } from '../../src/adapters/real-paths.js';
import { Block, DataBlock, LoadedManifest, ResourceBlock } from '../../src/manifest/types.js';

/**
 * Per-real-resource-type wiring needed to simulate an empty-then-populated org against the real
 * Connect REST paths each adapter in src/adapters/*.ts actually calls. Kept generic for the nine
 * resources that follow the plain create/read/update/delete(+status-poll) pattern; Connection and
 * Segment get bespoke handling below for their real create-then-lookup and dual-id quirks.
 */
type TypeConfig = {
  resourcePlural: string;
  listResponseKey: string;
  /** The real GET-collection path (with query) used by lookup() for this type's adoption check. */
  lookupPath: (props: Record<string, unknown>) => string;
  /** Overrides the default `{ [listResponseKey]: [] }` "nothing found yet" shape. */
  emptyLookupResponse?: () => unknown;
  /** Extra response fields a create() response needs beyond the echoed request body. */
  extraCreateFields?: (id: string, props: Record<string, unknown>) => Record<string, unknown>;
  idPrefix: string;
  async?: {
    action: string;
    statusField: string;
    terminalValue: string;
    failureValue: string;
  };
};

const TYPE_CONFIG: Record<string, TypeConfig> = {
  Connection: {
    resourcePlural: 'connections',
    listResponseKey: 'connections',
    lookupPath: (props) =>
      withQuery(collectionPath('connections'), {
        connectorType: props.connectorType as string | undefined,
        label: props.label as string | undefined,
      }),
    idPrefix: 'conn',
  },
  DataStream: {
    resourcePlural: 'data-streams',
    listResponseKey: 'dataStreams',
    lookupPath: () => collectionPath('data-streams'),
    extraCreateFields: (id, props) => ({
      // The real create/get response carries two distinct ids -- `id` and `recordId` -- and only
      // `recordId` is accepted by GET/PATCH/DELETE (confirmed live; see data-stream.ts's class
      // doc comment). The fake reuses the same counter-based value for both so every member path
      // wired below still matches, while still exercising toReadResult's real `recordId`
      // extraction.
      recordId: id,
      dataLakeObjectInfo: {
        ...(props.dataLakeObjectInfo as Record<string, unknown>),
        id: `${id}-dlo`,
        status: 'PROCESSING',
      },
    }),
    idPrefix: 'stream',
  },
  DataLakeObject: {
    resourcePlural: 'data-lake-objects',
    listResponseKey: 'dataLakeObjects',
    lookupPath: () => collectionPath('data-lake-objects'),
    idPrefix: 'dlo',
  },
  DataModelObject: {
    resourcePlural: 'data-model-objects',
    listResponseKey: 'dataModelObject',
    lookupPath: () => collectionPath('data-model-objects'),
    idPrefix: 'dmo',
  },
  DataModelObjectMapping: {
    resourcePlural: 'data-model-object-mappings',
    listResponseKey: 'objectSourceTargetMaps',
    lookupPath: (props) =>
      withQuery(collectionPath('data-model-object-mappings'), {
        dloDeveloperName: props.sourceEntityDeveloperName as string | undefined,
        dmoDeveloperName: props.targetEntityDeveloperName as string | undefined,
      }),
    extraCreateFields: (id) => ({ developerName: id }),
    idPrefix: 'mapping',
  },
  DataTransform: {
    resourcePlural: 'data-transforms',
    listResponseKey: 'dataTransforms',
    lookupPath: () => collectionPath('data-transforms'),
    idPrefix: 'transform',
  },
  IdentityResolutionRuleset: {
    resourcePlural: 'identity-resolutions',
    listResponseKey: 'identityResolutions',
    lookupPath: () => collectionPath('identity-resolutions'),
    idPrefix: 'irr',
    async: { action: 'run-now', statusField: 'lastJobStatus', terminalValue: 'SUCCESS', failureValue: 'FAILED' },
    // waitForCompletion polls rulesetStatus: "PUBLISHED" before calling run-now (confirmed live,
    // a freshly created ruleset starts "NEW"/"PUBLISHING" and run-now fails until it publishes).
    extraCreateFields: () => ({ rulesetStatus: 'PUBLISHED' }),
  },
  CalculatedInsight: {
    resourcePlural: 'calculated-insights',
    listResponseKey: 'items',
    lookupPath: () => collectionPath('calculated-insights'),
    emptyLookupResponse: () => ({ collection: { items: [] } }),
    idPrefix: 'ci',
    async: { action: 'run', statusField: 'calculatedInsightStatus', terminalValue: 'ACTIVE', failureValue: 'ERROR' },
  },
  Segment: {
    resourcePlural: 'segments',
    listResponseKey: 'segments',
    lookupPath: () => collectionPath('segments'),
    idPrefix: 'seg',
    async: { action: 'publish', statusField: 'segmentStatus', terminalValue: 'ACTIVE', failureValue: 'ERROR' },
  },
  ActivationTarget: {
    resourcePlural: 'activation-targets',
    listResponseKey: 'activationTargets',
    lookupPath: (props) => {
      const name = props.name as string | number | undefined;
      return withQuery(collectionPath('activation-targets'), {
        filters: name !== undefined ? `masterLabel in ${name}` : undefined,
      });
    },
    idPrefix: 'target',
  },
  ActivationPlatform: {
    resourcePlural: 'activation-platforms',
    listResponseKey: 'activationPlatforms',
    lookupPath: () => withQuery(collectionPath('activation-platforms'), { activationPlatformView: 'Developer' }),
    idPrefix: 'platform',
    async: { action: 'publish', statusField: 'status', terminalValue: 'Active', failureValue: 'Error' },
  },
  Activation: {
    resourcePlural: 'activations',
    listResponseKey: 'activations',
    lookupPath: (props) => {
      const name = props.name as string | number | undefined;
      return withQuery(collectionPath('activations'), {
        filters: name !== undefined ? `name in ${name}` : undefined,
      });
    },
    idPrefix: 'act',
    // Real full-refresh path is `actions/{id}/full-refresh` (id after "actions"), unlike every
    // other resource's `{id}/actions/{verb}` pattern -- wired as a special case below, not via
    // the generic `memberPath(...)/actions/{action}` templating other async resources use.
    // Status field is `status` (not `lastPublishStatus`, which a real, already-working
    // Activation may never have populated at all) -- confirmed live, see activation.ts.
    async: {
      action: 'full-refresh',
      statusField: 'status',
      terminalValue: 'ACTIVE',
      failureValue: 'ERROR',
    },
  },
  TagAssignment: {
    resourcePlural: 'data-governance/tag-assignments',
    listResponseKey: 'tagAssignments',
    lookupPath: (props) =>
      withQuery(collectionPath('data-governance/tag-assignments'), {
        objectName: props.objectName as string | undefined,
        fieldName: props.fieldName as string | undefined,
        tagFullyQualifiedName: props.tagFullyQualifiedName as string | undefined,
      }),
    idPrefix: 'tagassign',
  },
  ClassificationAssignment: {
    resourcePlural: 'data-governance/classification-assignments',
    listResponseKey: 'classificationAssignments',
    lookupPath: (props) =>
      withQuery(collectionPath('data-governance/classification-assignments'), {
        classificationFullyQualifiedName: props.classificationFullyQualifiedName as string | undefined,
        tagFullyQualifiedName: props.tagFullyQualifiedName as string | undefined,
      }),
    idPrefix: 'classassign',
  },
  // ObjectAccessGrant and AccessPolicyRule have no counter-based numeric id at all (their real
  // identity is a composite key the adapter itself synthesizes) -- handled entirely as special
  // cases below, not via this generic TYPE_CONFIG-driven create-path wiring.
  AccessPolicy: {
    resourcePlural: 'data-governance/access-policies',
    listResponseKey: 'records',
    lookupPath: () => collectionPath('data-governance/access-policies'),
    idPrefix: 'policy',
  },
};

function resourceBlocks(manifest: LoadedManifest): ResourceBlock[] {
  return manifest.blocks.filter((b): b is ResourceBlock => (b.kind ?? 'resource') === 'resource');
}

function dataBlocks(manifest: LoadedManifest): DataBlock[] {
  return manifest.blocks.filter((b: Block): b is DataBlock => b.kind === 'data');
}

export type FailureToggle = { failType?: string };

/**
 * Builds a FakeConnectRestClient simulating an initially-empty org that accepts the full
 * create/read/update/delete (+ async job) lifecycle for every real resource type this plugin
 * manages. Every adoption-lookup GET the given manifest's blocks could trigger is pre-wired to
 * report "not found" -- there's nothing live before a test applies anything.
 *
 * `failureToggle`, when supplied, is read live (not snapshotted) on every status poll: setting
 * `failureToggle.failType = 'CalculatedInsight'` makes the next (and every subsequent) poll of
 * that type's async job report its real failure status value, so tests can inject a mid-apply
 * failure and later clear it to simulate a resumed, successful retry against the same org.
 */
export function buildFakeOrg(manifest: LoadedManifest, failureToggle: FailureToggle = {}): FakeConnectRestClient {
  const client = new FakeConnectRestClient();
  const counters = new Map<string, number>();
  const schemas = new Map<string, Array<Record<string, unknown>>>();

  for (const block of resourceBlocks(manifest)) {
    const config = TYPE_CONFIG[block.type];
    if (!config) continue;
    const partial = (value: unknown): unknown => {
      if (typeof value === 'string')
        return value.replace(
          /\$\{([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\.(apiName|dlApiName)\}/g,
          (match, type: string, name: string, field: string) => {
            const data = dataBlocks(manifest).find((b) => b.type === type && b.name === name);
            if (typeof data?.lookup.name === 'string') return data.lookup.name;
            const resource = resourceBlocks(manifest).find((b) => b.type === type && b.name === name);
            const resolved =
              field === 'dlApiName'
                ? (resource?.properties.dataLakeObjectInfo as { name?: string } | undefined)?.name
                : resource?.properties.name;
            return typeof resolved === 'string' ? resolved : match;
          }
        );
      if (Array.isArray(value)) return value.map(partial);
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, partial(child)]));
      return value;
    };
    client.on(
      'GET',
      config.lookupPath(partial(block.properties) as Record<string, unknown>),
      () => config.emptyLookupResponse?.() ?? { [config.listResponseKey]: [] }
    );
    client.on(
      'GET',
      config.lookupPath(block.properties),
      () => config.emptyLookupResponse?.() ?? { [config.listResponseKey]: [] }
    );
  }

  // `kind: "data"` blocks reference something that already exists live (e.g. a real Salesforce
  // standard DMO) -- DataModelObjectAdapter.lookup() GETs directly by name (the real collection
  // list defaults to limit=50 and doesn't reliably include every DMO, confirmed live), so wire
  // that single-object GET for every standard DMO any data block in this manifest looks up by
  // name, keyed by that real name.
  const dmoDataBlocks = dataBlocks(manifest).filter((b) => b.type === 'DataModelObject');
  dmoDataBlocks.forEach((b, i) => {
    const name = b.lookup.name as string;
    client.on('GET', memberPath('data-model-objects', name), () => ({
      id: `std-dmo-${i + 1}`,
      name,
      category: 'PROFILE',
      dataSpaceName: 'default',
      fields: [],
    }));
  });

  for (const [type, config] of Object.entries(TYPE_CONFIG)) {
    // DataModelObjectMapping's real create endpoint requires `dataspace` as a query param --
    // every other resource's create path has no query string.
    const createPath =
      type === 'DataModelObjectMapping'
        ? withQuery(collectionPath(config.resourcePlural), { dataspace: 'default' })
        : collectionPath(config.resourcePlural);
    // eslint-disable-next-line complexity -- model each adapter's verified response and server state independently.
    client.on('POST', createPath, (req) => {
      const props = structuredClone(req.body ?? {}) as Record<string, unknown>;
      if (type === 'DataStream' && props.dataLakeObjectInfo) {
        const dlo = props.dataLakeObjectInfo as Record<string, unknown>;
        const primary = dlo.dataLakeFieldInputRepresentations as Array<{ name: string }>;
        const schema = [...schemas.values()].find((fields) =>
          fields.some((f) => primary.some((p) => p.name === f.name))
        );
        if (schema)
          dlo.dataLakeFieldInputRepresentations = schema.map((f) => ({
            ...f,
            isPrimaryKey: primary.some((p) => p.name === f.name),
          }));
      }
      const next = (counters.get(type) ?? 0) + 1;
      counters.set(type, next);
      const id = `${config.idPrefix}-${next}`;
      const name = typeof props.name === 'string' ? props.name : undefined;
      const extra = config.extraCreateFields?.(id, props) ?? {};

      if (type === 'Connection') {
        // Real API returns an empty create body; the adapter follows up with a label lookup
        // (the real API rewrites `name` on create to an unpredictable value, but preserves
        // `label` exactly -- see src/adapters/connection.ts), which requires connectorType as a
        // query param (the real list endpoint rejects a label-only query).
        const connectorType = typeof props.connectorType === 'string' ? props.connectorType : undefined;
        const label = typeof props.label === 'string' ? props.label : undefined;
        client.on('GET', withQuery(collectionPath(config.resourcePlural), { connectorType, label }), () => ({
          connections: [{ ...props, id }],
        }));
        client.on('GET', memberPath(config.resourcePlural, id), () => ({ ...props, id }));
        client.on('PATCH', memberPath(config.resourcePlural, id), (updateReq) => ({
          ...(updateReq.body as Record<string, unknown>),
          id,
        }));
        client.on('DELETE', memberPath(config.resourcePlural, id), () => ({}));
        // IngestApi-connectorType DataStream.create() upserts a schema on the connection before
        // creating the stream -- see src/adapters/data-stream.ts.
        client.on('PUT', `${memberPath(config.resourcePlural, id)}/schema`, (request) => {
          const schema = (request.body as { schemas: Array<{ fields: Array<Record<string, unknown>> }> }).schemas[0];
          schemas.set(id, schema.fields);
          return {};
        });
        return {};
      }

      if (type === 'CalculatedInsight') {
        // CalculatedInsightAdapter.toReadResult uses the real `apiName` as `id` (there's no
        // separate numeric id for this resource) -- every member path (GET/PATCH/DELETE/action)
        // must be keyed by apiName, not this fake's internal counter-based id.
        const apiName = typeof props.apiName === 'string' ? props.apiName : id;
        client.on('GET', memberPath(config.resourcePlural, apiName), () => ({
          ...props,
          apiName,
          calculatedInsightStatus:
            failureToggle.failType === type ? config.async!.failureValue : config.async!.terminalValue,
        }));
        client.on('PATCH', memberPath(config.resourcePlural, apiName), (updateReq) => ({
          ...(updateReq.body as Record<string, unknown>),
          apiName,
        }));
        client.on('DELETE', memberPath(config.resourcePlural, apiName), () => ({}));
        client.on('POST', `${memberPath(config.resourcePlural, apiName)}/actions/${config.async!.action}`, () => ({}));
        return { ...props, apiName, calculatedInsightStatus: 'PROCESSING' };
      }

      if (type === 'AccessPolicy') {
        // AccessPolicyAdapter.toReadResult uses the real client-supplied `name` as `id` (there's
        // no separate numeric id for this resource) -- every member path (GET/PATCH/DELETE) must
        // be keyed by name, not this fake's internal counter-based id.
        const policyName = typeof props.name === 'string' ? props.name : id;
        client.on('GET', memberPath(config.resourcePlural, policyName), () => ({ ...props, name: policyName }));
        client.on('PATCH', memberPath(config.resourcePlural, policyName), (updateReq) => ({
          name: policyName,
          ...(updateReq.body as Record<string, unknown>),
        }));
        client.on('DELETE', memberPath(config.resourcePlural, policyName), () => ({}));
        return { ...props, name: policyName };
      }

      if (type === 'Segment') {
        // Dual-id: update()/delete() re-GET by numeric id to resolve apiName, then PATCH/DELETE
        // the apiName-keyed path. waitForCompletion also polls this same numeric-id GET.
        // GET /ssot/segments/{id} wraps its single result in { segments: [...] } -- confirmed
        // live, unlike the create/update responses (bare) -- exercised here so e2e tests catch a
        // regression in SegmentAdapter's unwrapping.
        const apiName = typeof props.displayName === 'string' ? props.displayName : id;
        client.on('GET', memberPath(config.resourcePlural, id), () => ({
          segments: [
            {
              ...props,
              marketSegmentId: id,
              apiName,
              segmentStatus: failureToggle.failType === type ? config.async!.failureValue : config.async!.terminalValue,
            },
          ],
        }));
        client.on('PATCH', memberPath(config.resourcePlural, apiName), (updateReq) => ({
          ...(updateReq.body as Record<string, unknown>),
          marketSegmentId: id,
          apiName,
        }));
        client.on('DELETE', memberPath(config.resourcePlural, apiName), () => ({}));
        client.on('POST', `${memberPath(config.resourcePlural, id)}/actions/${config.async!.action}`, () => ({}));
        return { ...props, marketSegmentId: id, apiName, segmentStatus: 'PROCESSING' };
      }

      if (config.async) {
        const asyncConfig = config.async;
        // Activation's real full-refresh path is `actions/{id}/full-refresh` -- id comes after
        // "actions", unlike every other async resource's `{id}/actions/{verb}` pattern.
        const actionPath =
          type === 'Activation'
            ? `${collectionPath(config.resourcePlural)}/actions/${id}/${asyncConfig.action}`
            : `${memberPath(config.resourcePlural, id)}/actions/${asyncConfig.action}`;
        client.on('POST', actionPath, () => ({}));
        client.on('GET', memberPath(config.resourcePlural, id), () => ({
          ...props,
          id,
          name: name ?? id,
          [asyncConfig.statusField]:
            failureToggle.failType === type ? asyncConfig.failureValue : asyncConfig.terminalValue,
          ...extra,
        }));
      } else {
        client.on('GET', memberPath(config.resourcePlural, id), () => ({
          ...props,
          id,
          name: name ?? id,
          ...extra,
        }));
      }

      if (type === 'DataStream') {
        client.on(
          'DELETE',
          withQuery(memberPath(config.resourcePlural, id), { shouldDeleteDataLakeObject: true }),
          () => ({})
        );
      } else {
        client.on('DELETE', memberPath(config.resourcePlural, id), () => {
          if (['ActivationTarget', 'IdentityResolutionRuleset', 'DataModelObjectMapping'].includes(type)) {
            // Model the committed server deletion independently from its empty response.
            client.on('GET', memberPath(config.resourcePlural, id), () => {
              throw Object.assign(new Error('Activation target not found'), {
                statusCode: 404,
                errorCode: 'RESOURCE_NOT_FOUND',
              });
            });
          }
          return {};
        });
      }
      client.on('PATCH', memberPath(config.resourcePlural, id), (updateReq) => ({
        ...(updateReq.body as Record<string, unknown>),
        id,
        name: name ?? id,
      }));
      client.on('PUT', memberPath(config.resourcePlural, id), (updateReq) => ({
        ...(updateReq.body as Record<string, unknown>),
        id,
        name: name ?? id,
      }));

      return { ...props, id, name: name ?? id, status: 'PROCESSING', ...extra };
    });
  }

  // ObjectAccessGrant and AccessPolicyRule have no server-generated id -- their real paths are
  // fully determined by manifest-declared properties (a composite key / parent+rule name), not a
  // counter-assigned id like every other resource above, so they're wired per-block here instead
  // of through the generic TYPE_CONFIG create-path loop. Each type's real `apiName` always ends
  // up equal to its own declared `name` property (every adapter above this point resolves it that
  // way), so a `${Type.name.apiName}` reference used in a *path* position can be approximated
  // here by looking up that other block's `name` property directly -- real resolution only
  // happens later, inside ApplyExecutor, once the referenced block has actually been applied.
  const resourceBlocksByKey = new Map(resourceBlocks(manifest).map((b) => [`${b.type}.${b.name}`, b]));
  const dataBlocksByKey = new Map(dataBlocks(manifest).map((b) => [`${b.type}.${b.name}`, b]));
  function resolveApiNameRef(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const match = /^\$\{([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\.(?:apiName|dlApiName)\}$/.exec(value);
    if (!match) return value;
    const [, refType, refName] = match;
    const key = `${refType}.${refName}`;
    // A `kind: "data"` block's "apiName" is whatever its own lookup already names it by (e.g. a
    // real Salesforce standard DMO's name) -- there's nothing this fake creates, so the lookup
    // value itself is the answer, not a counter-assigned id like resource blocks get.
    const dataLookupName = dataBlocksByKey.get(key)?.lookup.name as string | undefined;
    if (dataLookupName) return dataLookupName;
    const refProps = resourceBlocksByKey.get(key)?.properties;
    return (
      (refType === 'DataStream'
        ? (refProps?.dataLakeObjectInfo as { name?: string } | undefined)?.name
        : (refProps?.name as string | undefined)) ?? value
    );
  }

  for (const block of resourceBlocks(manifest)) {
    if (block.type === 'DataModelObjectMapping') {
      const props = block.properties;
      client.on(
        'GET',
        withQuery(collectionPath('data-model-object-mappings'), {
          dloDeveloperName: resolveApiNameRef(props.sourceEntityDeveloperName),
          dmoDeveloperName: resolveApiNameRef(props.targetEntityDeveloperName),
        }),
        () => ({ objectSourceTargetMaps: [] })
      );
    }
    if (block.type === 'ObjectAccessGrant') {
      const props = block.properties;
      const objectApiName = resolveApiNameRef(props.objectApiName) as string;
      const permissionSetName = props.permissionSetName as string;
      const dataSpaceName = (props.dataSpaceName as string | undefined) ?? 'default';
      client.on(
        'GET',
        withQuery(collectionPath('data-governance/object-access-grants'), { objectApiName, permissionSetName }),
        () => ({ grants: [] })
      );
      const grantPath = withQuery(memberPath('data-governance/object-access-grants', objectApiName), {
        permissionSetName,
        dataSpaceName,
      });
      client.on('POST', collectionPath('data-governance/object-access-grants'), (req) => ({
        ...(req.body as Record<string, unknown>),
      }));
      client.on('GET', grantPath, () => ({ objectApiName, permissionSetName, dataSpaceName }));
      client.on('DELETE', grantPath, () => ({}));
    }

    if (block.type === 'AccessPolicyRule') {
      const props = block.properties;
      const policyName = resolveApiNameRef(props.policyName) as string;
      const ruleName = props.name as string;
      const rulePath = `${memberPath('data-governance/access-policies', policyName)}/rules/${ruleName}`;
      let rule: Record<string, unknown> | undefined;
      client.on('PUT', rulePath, (req) => {
        rule = { id: `${policyName}-rule`, ...(req.body as Record<string, unknown>) };
        return rule;
      });
      client.on('GET', rulePath, () => rule);
    }
  }

  return client;
}
