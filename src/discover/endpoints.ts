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

/** Named lists of real values discovered from earlier stages, used to fan out a later endpoint. */
export type EntitySource = 'dmoNames' | 'dataSpaceNames' | 'activationTargetIds' | 'activationPlatformIds' | 'modelIds';

export type DiscoverEndpoint = {
  /** Postman folder name this endpoint is grouped under -- used as the output subdirectory. */
  folder: string;
  /** JSON file name (no extension) within that folder. */
  fileName: string;
  /** The real Connect REST path, no query string. */
  path: string;
  /**
   * Present only for endpoints whose real query params have no documented default (no
   * "if unspecified, ..." language) and can't be resolved even with a discovered entity list
   * (e.g. an external ad platform's accountId, or a channel enum value). These are recorded in
   * the discovery summary but never requested.
   */
  skipReason?: string;
  /**
   * Present only for endpoints that require a real id/name this command can supply by looping
   * over a list discovered in an earlier stage -- e.g. `dataModelObjectApiName` once every real
   * DMO name is known. The endpoint is called once per discovered value, and every result is
   * written as one dictionary file keyed by that value, rather than skipped or erroring.
   */
  dependsOn?: { source: EntitySource; param: string };
};

export type DiscoveryStage = {
  name: string;
  endpoints: DiscoverEndpoint[];
};

/**
 * Every `GET` endpoint in the real Salesforce Data 360 Connect REST API that lists a collection
 * with no required path parameter (member-detail endpoints like `GET /ssot/connections/{id}` are
 * out of scope -- this command captures "get all", not "get one"). Enumerated from the official
 * "Salesforce Data 360 Connect APIs" Postman collection; folder names match the collection's own
 * grouping.
 *
 * Grouped into stages that run in order, not alphabetically, so later stages can fan out over
 * real names/ids discovered by earlier ones (DMO names, data space names, activation
 * target/platform ids, model ids) instead of erroring on a required query param this command
 * can't otherwise supply. `/ssot/connections` is listed here for completeness but is handled as a
 * special case in the runner (it requires a per-connector-type loop fed by both the connectors
 * catalog and real Data Streams usage), not the generic single-GET path.
 */
export const DISCOVERY_STAGES: DiscoveryStage[] = [
  {
    // Run first: lists every DMO (and other entity types) in the org, the foundational names
    // every later stage's fan-out depends on.
    name: 'Metadata',
    endpoints: [
      { folder: 'Metadata', fileName: 'metadata', path: '/ssot/metadata' },
      { folder: 'Metadata', fileName: 'metadata-entities', path: '/ssot/metadata-entities' },
      { folder: 'Metadata', fileName: 'profile-metadata', path: '/ssot/profile/metadata' },
    ],
  },
  {
    name: 'Data Spaces',
    endpoints: [{ folder: 'Data Spaces', fileName: 'data-spaces', path: '/ssot/data-spaces' }],
  },
  {
    // Confirms/supplements the DMO name list from Metadata with full DMO bodies.
    name: 'Data Model Objects',
    endpoints: [{ folder: 'Data Model Objects', fileName: 'data-model-objects', path: '/ssot/data-model-objects' }],
  },
  {
    // Connections right after the foundational metadata, per the requested org-shape order.
    // Data Streams is fetched here (not in the Ingestion stage below) because the real
    // connectorType catalog (`connectors`) doesn't include every connectorType actually in use --
    // Data Streams' `connectorInfo.connectorType` is the second source connections' fan-out needs
    // (see discoverConnections in run-discovery.ts). Its own file is still written to the
    // Data Streams folder; this only changes when the fetch happens, not where its output lands.
    name: 'Connections',
    endpoints: [
      { folder: 'Connections', fileName: 'connectors', path: '/ssot/connectors' },
      { folder: 'Data Streams', fileName: 'data-streams', path: '/ssot/data-streams' },
      { folder: 'Connections', fileName: 'connections', path: '/ssot/connections' },
    ],
  },
  {
    name: 'Ingestion',
    endpoints: [
      { folder: 'Data Lake Objects', fileName: 'data-lake-objects', path: '/ssot/data-lake-objects' },
      { folder: 'Data Transforms', fileName: 'data-transforms', path: '/ssot/data-transforms' },
    ],
  },
  {
    // Real API requires dmoDeveloperName -- previously called with no params and errored
    // ("DMO or Source Object developer Name is missing"). Now looped over every DMO name.
    name: 'Data Model Mappings',
    endpoints: [
      {
        folder: 'Data Model Objects',
        fileName: 'data-model-object-mappings',
        path: '/ssot/data-model-object-mappings',
        dependsOn: { source: 'dmoNames', param: 'dmoDeveloperName' },
      },
    ],
  },
  {
    name: 'Activation Layer',
    endpoints: [
      {
        folder: 'Activation External Platforms',
        fileName: 'activation-external-platforms',
        path: '/ssot/activation-external-platforms',
      },
      { folder: 'Activation Platforms', fileName: 'activation-platforms', path: '/ssot/activation-platforms' },
      { folder: 'Activation Targets', fileName: 'activation-targets', path: '/ssot/activation-targets' },
      {
        folder: 'Activation Targets',
        fileName: 'activation-platforms',
        path: '/ssot/activation-targets/metadata/activation-platforms',
      },
      {
        folder: 'Activation Targets',
        fileName: 'communication-capping-data-spaces',
        path: '/ssot/activation-targets/metadata/communication-capping-data-spaces',
      },
      {
        folder: 'Activation Targets',
        fileName: 'mc-enterprises',
        path: '/ssot/activation-targets/metadata/mc-enterprises',
      },
      { folder: 'Activations', fileName: 'activations', path: '/ssot/activations' },
      {
        folder: 'Activations',
        fileName: 'activatable-data-object-categories',
        path: '/ssot/activations/metadata/activatable-data-object-categories',
      },
      {
        folder: 'Activations',
        fileName: 'related-attribute-configuration-limits',
        path: '/ssot/activations/metadata/limits/related-attribute-configuration-limits',
      },
      { folder: 'Segments', fileName: 'segments', path: '/ssot/segments' },
      { folder: 'Calculated Insights', fileName: 'calculated-insights', path: '/ssot/calculated-insights' },
      { folder: 'Identity Resolutions', fileName: 'identity-resolutions', path: '/ssot/identity-resolutions' },
      { folder: 'Machine Learning', fileName: 'configured-models', path: '/ssot/machine-learning/configured-models' },
      { folder: 'Machine Learning', fileName: 'model-artifacts', path: '/ssot/machine-learning/model-artifacts' },
      { folder: 'Machine Learning', fileName: 'jobs', path: '/ssot/machine-learning/jobs' },
      { folder: 'Machine Learning', fileName: 'retrievers', path: '/ssot/machine-learning/retrievers' },
    ],
  },
  {
    // Every endpoint here previously either errored on a missing required param against a real
    // org, or was skipped for lack of a discoverable value -- now resolvable from entities found
    // in earlier stages.
    name: 'Entity Fan-Out',
    endpoints: [
      {
        folder: 'Activations',
        fileName: 'channels',
        path: '/ssot/activations/metadata/channels',
        dependsOn: { source: 'dataSpaceNames', param: 'dataSpace' },
      },
      {
        folder: 'Activations',
        fileName: 'consent-data-model-objects',
        path: '/ssot/activations/metadata/consent-data-model-objects',
        dependsOn: { source: 'dataSpaceNames', param: 'dataSpace' },
      },
      {
        folder: 'Activations',
        fileName: 'data-sources',
        path: '/ssot/activations/metadata/data-sources',
        dependsOn: { source: 'dmoNames', param: 'dataModelObjectApiName' },
      },
      {
        folder: 'Activations',
        fileName: 'streaming-eligibility',
        path: '/ssot/activations/metadata/streaming-eligibility',
        dependsOn: { source: 'dmoNames', param: 'dataModelObjectApiName' },
      },
      {
        folder: 'Activations',
        fileName: 'match-boost-identity-providers',
        path: '/ssot/activations/metadata/match-boost-identity-providers',
        dependsOn: { source: 'activationTargetIds', param: 'activationTargetId' },
      },
      {
        folder: 'Activation Targets',
        fileName: 'target-platform-fields',
        path: '/ssot/activation-targets/metadata/target-platform-fields',
        dependsOn: { source: 'activationPlatformIds', param: 'platformIdOrName' },
      },
      {
        folder: 'Machine Learning',
        fileName: 'prediction-job-definitions',
        path: '/ssot/machine-learning/prediction-job-definitions',
        dependsOn: { source: 'modelIds', param: 'modelId' },
      },
      // Still genuinely unresolvable even with every discovered entity list:
      {
        folder: 'Activation Targets',
        fileName: 'dataspace-account-validation',
        path: '/ssot/activation-targets/metadata/dataspace-account-validation',
        skipReason: 'requires accountId -- an external ad platform account id, not discoverable from this org',
      },
      {
        folder: 'Activations',
        fileName: 'channel-preferences',
        path: '/ssot/activations/metadata/channel-preferences',
        skipReason: 'requires channel, a fixed enum value (Email/Phone/Push/...) -- no org-wide "list all" meaning',
      },
      {
        folder: 'Activations',
        fileName: 'related-attribute-activation-quota',
        path: '/ssot/activations/metadata/limits/related-attribute-activation-quota',
        skipReason:
          'requires activationId to exclude one specific activation from a quota count -- no org-wide "list all" meaning',
      },
    ],
  },
  {
    // No dependency on anything discovered above -- runs last as one concurrent batch.
    name: 'Other',
    endpoints: [
      { folder: 'Agent Configuration', fileName: 'agents', path: '/ssot/agentic/agents' },
      { folder: 'Clean Rooms', fileName: 'collaborations', path: '/ssot/data-clean-room/collaborations' },
      { folder: 'Clean Rooms', fileName: 'providers', path: '/ssot/data-clean-room/providers' },
      { folder: 'Clean Rooms', fileName: 'specifications', path: '/ssot/data-clean-room/specifications' },
      { folder: 'Clean Rooms', fileName: 'templates', path: '/ssot/data-clean-room/templates' },
      { folder: 'Data Action Targets', fileName: 'data-action-targets', path: '/ssot/data-action-targets' },
      { folder: 'Data Actions', fileName: 'data-actions', path: '/ssot/data-actions' },
      { folder: 'Data Governance', fileName: 'access-policies', path: '/ssot/data-governance/access-policies' },
      { folder: 'Data Governance', fileName: 'auto-tagging-jobs', path: '/ssot/data-governance/auto-tagging-jobs' },
      {
        folder: 'Data Governance',
        fileName: 'classification-assignments',
        path: '/ssot/data-governance/classification-assignments',
      },
      {
        folder: 'Data Governance',
        fileName: 'classification-taxonomies',
        path: '/ssot/data-governance/classification-taxonomies',
      },
      { folder: 'Data Governance', fileName: 'classifications', path: '/ssot/data-governance/classifications' },
      { folder: 'Data Governance', fileName: 'tag-assignments', path: '/ssot/data-governance/tag-assignments' },
      { folder: 'Data Governance', fileName: 'tag-suggestions', path: '/ssot/data-governance/tag-suggestions' },
      { folder: 'Data Governance', fileName: 'tag-taxonomies', path: '/ssot/data-governance/tag-taxonomies' },
      { folder: 'Data Governance', fileName: 'tags', path: '/ssot/data-governance/tags' },
      { folder: 'Data Graphs', fileName: 'metadata', path: '/ssot/data-graphs/metadata' },
      { folder: 'Data Kits', fileName: 'data-kits', path: '/ssot/data-kits' },
      { folder: 'Data Kits', fileName: 'available-components', path: '/ssot/data-kits/available-components' },
      { folder: 'Data Shares', fileName: 'data-shares', path: '/ssot/data-shares' },
      { folder: 'Document AI', fileName: 'configurations', path: '/ssot/document-processing/configurations' },
      { folder: 'Document AI', fileName: 'global-config', path: '/ssot/document-processing/global-config' },
      { folder: 'Insights', fileName: 'metadata', path: '/ssot/insight/metadata' },
      { folder: 'Notebook AI', fileName: 'knowledge-spaces', path: '/ssot/knowledge-space' },
      { folder: 'Notebook AI', fileName: 'knowledge-space-config', path: '/ssot/knowledge-space/config' },
      { folder: 'Notebook AI', fileName: 'knowledge-libraries', path: '/ssot/knowledge-space/library' },
      { folder: 'Private Network Routes', fileName: 'private-network-routes', path: '/ssot/private-network-routes' },
      { folder: 'Search Index', fileName: 'search-index', path: '/ssot/search-index' },
      { folder: 'Search Index', fileName: 'search-index-config', path: '/ssot/search-index/config' },
    ],
  },
];

/** Flat view of every endpoint across every stage, in stage order -- for callers that don't care about staging. */
export const DISCOVER_ENDPOINTS: DiscoverEndpoint[] = DISCOVERY_STAGES.flatMap((stage) => stage.endpoints);
