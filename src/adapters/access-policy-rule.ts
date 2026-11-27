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
import { AdapterContext, AdapterReadResult, FieldClassification, ResourceAdapter } from './types.js';
import { safePutProperties } from './configuration.js';
import { memberPath } from './real-paths.js';

const ID_DELIMITER = '::';

function encodeId(policyName: string, ruleName: string): string {
  return `${policyName}${ID_DELIMITER}${ruleName}`;
}

function decodeId(id: string): { policyName: string; ruleName: string } {
  const [policyName, ruleName] = id.split(ID_DELIMITER);
  return { policyName, ruleName };
}

function rulePath(policyName: string, ruleName: string): string {
  return `${memberPath('data-governance/access-policies', policyName)}/rules/${encodeURIComponent(ruleName)}`;
}

function toReadResult(policyName: string, item: Record<string, unknown>): AdapterReadResult {
  return {
    id: encodeId(policyName, String(item.name)),
    apiName: encodeId(policyName, String(item.name)),
    properties: { ...item, policyName },
  };
}

function splitPolicyName(properties: Record<string, unknown>): {
  policyName: string;
  body: Record<string, unknown>;
} {
  const { policyName, ...body } = properties;
  if (typeof policyName !== 'string') {
    throw new Error('AccessPolicyRule requires a "policyName" property naming its parent AccessPolicy');
  }
  return { policyName, body };
}

/**
 * A single field-level masking/access rule within an `AccessPolicy`,
 * `/ssot/data-governance/access-policies/{name}/rules/{ruleName}` (confirmed against the official
 * Connect REST API reference). The manifest-declared `policyName` property names the parent
 * policy (typically `${AccessPolicy.x.apiName}`) -- it's not a real field on the rule itself, so
 * it's read and stripped out of `properties` before building the request body, the same way
 * `DataModelObjectMapping.create()` reads `dataSpaceName` for a query param rather than sending it
 * in the body.
 *
 * There is no `POST`/`PATCH`/`DELETE` for a single rule in the real API -- only `GET` and a `PUT`
 * that **upserts** (creates if absent, replaces if present). This doesn't fit
 * `RestAdapterBase`'s generic CRUD shape (separate create vs. update calls, a DELETE that
 * exists), so this adapter implements `ResourceAdapter` directly: `create()` and `update()` both
 * call the same PUT. Standalone `delete()` now rejects as unsupported: it must not pretend
 * that a completed method call removed the rule. Deleting a parent can cascade, but a complete
 * reviewed live inventory and explicit cascade approval are required. Standalone deletion is blocked before mutations; a reviewed parent cascade
 * retains child tracking until the parent and every reviewed child are confirmed absent.
 *
 * `id`/`apiName` are a synthesized `${policyName}::${ruleName}` composite, since the rule's real
 * identity is scoped to its parent policy (same reasoning as `ObjectAccessGrant`'s composite id).
 *
 * **`ruleConsumer` is required despite the official spec listing it as optional** -- confirmed
 * live: omitting it always fails with `ruleConsumer is required.`, on both the standalone `PUT
 * rules/{ruleName}` endpoint this adapter uses and the documented inline-rules-on-policy-create
 * path. **`resourceScopeType: "FIELD"` combined with `effect: "Transform"` fails server-side
 * with an opaque `UNKNOWN_EXCEPTION` ("...couldn't be saved because of an internal error...")
 * in this org** -- confirmed exhaustively live: the exact request body from the official spec
 * example (just substituting a real DMO/DLO name), tried via both the PUT endpoint and the
 * inline-rules-on-policy-create POST, with every documented enum value for `ruleConsumer`/
 * `category`/`resourceScopeType`/`resourceTransform`, with and without `transformPrecedence`,
 * and with `resourceDomains` as a bare object name or a field-qualified `object.field` -- every
 * combination that should (per docs) succeed for `FIELD`-scope `Transform` instead hits this
 * same internal error, while the identical shape at `RECORD` scope with `Forbid`/`Permit` saves
 * cleanly. This looks like a genuine server-side limitation/bug for field-level masking, not a
 * request-shape problem this adapter can work around.
 */
export class AccessPolicyRuleAdapter implements ResourceAdapter {
  public readonly type = 'AccessPolicyRule';
  public readonly deletionCapability = 'parent-cascade-only' as const;
  public readonly fieldClassification: FieldClassification = {
    policyName: 'replace',
    name: 'replace',
    category: 'replace',
    resourceScopeType: 'replace',
    label: 'update',
    effect: 'update',
    action: 'update',
    principalScopeType: 'update',
    principalAuthenticationLevel: 'update',
    resourceDomains: 'update',
    resourceTransform: 'update',
    resourceTransformArguments: 'update',
    transformPrecedence: 'update',
    ruleConsumer: 'update',
  };

  /**
   * `PlanEngine` resolves dependency references before lookup. Defensive callers can still
   * supply unresolved templates, which cannot be used as real policy identities. Treating that as "not found" (rather than issuing a GET
   * against a garbage path) is correct anyway: if the parent `AccessPolicy` is itself declared by
   * reference, it can't already exist live under a name this plan doesn't know yet.
   */
  public async lookup(ctx: AdapterContext, lookupKey: Record<string, unknown>): Promise<AdapterReadResult> {
    const policyName = lookupKey.policyName as string | undefined;
    const name = lookupKey.name as string | undefined;
    if (!policyName || !name || policyName.includes('${')) return undefined;
    return this.read(ctx, encodeId(policyName, name));
  }

  // eslint-disable-next-line class-methods-use-this -- interface methods; this adapter is stateless, routing is pure functions above.
  public read(ctx: AdapterContext, id: string): Promise<AdapterReadResult> {
    const { policyName, ruleName } = decodeId(id);
    return ctx.client
      .request<Record<string, unknown>>({ method: 'GET', path: rulePath(policyName, ruleName) })
      .then((item) => (item ? toReadResult(policyName, item) : undefined));
  }

  // eslint-disable-next-line class-methods-use-this -- see read() above.
  public create(ctx: AdapterContext, properties: Record<string, unknown>): Promise<AdapterReadResult> {
    const { policyName, body } = splitPolicyName(properties);
    const ruleName = String(body.name);
    return ctx.client
      .request<Record<string, unknown>>({ method: 'PUT', path: rulePath(policyName, ruleName), body })
      .then((item) => (item ? toReadResult(policyName, item) : undefined));
  }

  public async update(
    ctx: AdapterContext,
    id: string,
    properties: Record<string, unknown>
  ): Promise<AdapterReadResult> {
    const { policyName, ruleName } = decodeId(id);
    const live = await this.read(ctx, id);
    if (!live) throw new Error('Rule configuration is unreadable; safe PUT blocked.');
    const { body } = splitPolicyName(safePutProperties(this.type, live.properties, properties));
    return ctx.client
      .request<Record<string, unknown>>({ method: 'PUT', path: rulePath(policyName, ruleName), body })
      .then((item) => (item ? toReadResult(policyName, item) : undefined));
  }

  // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars -- interface shape; see class doc.
  public delete(ctx: AdapterContext, id: string): Promise<void> {
    return Promise.reject(
      Object.assign(
        new Error('AccessPolicyRule has no standalone deletion API; a complete reviewed parent cascade is required.'),
        { name: 'UNSUPPORTED_DELETE' }
      )
    );
  }
}
