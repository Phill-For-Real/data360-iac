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

/**
 * Real Salesforce Data 360 Connect REST API path builders. Every resource type in this plugin
 * lives under the same base shape: a `/ssot/<plural>` collection, `/ssot/<plural>/{idOrName}`
 * members, and `/ssot/<plural>/{idOrName}/actions/<verb>` for async operations. Verified against
 * the official "Salesforce Data 360 Connect APIs" Postman collection -- see API_NOTES.md.
 */
export function collectionPath(resourcePlural: string): string {
  return `/ssot/${resourcePlural}`;
}

export function memberPath(resourcePlural: string, idOrName: string): string {
  return `${collectionPath(resourcePlural)}/${encodeURIComponent(idOrName)}`;
}

export function actionPath(resourcePlural: string, idOrName: string, action: string): string {
  return `${memberPath(resourcePlural, idOrName)}/actions/${action}`;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export function withQuery(path: string, params: QueryParams): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return query ? `${path}?${query}` : path;
}
