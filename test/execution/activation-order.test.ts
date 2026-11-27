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
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { ApplyExecutor } from '../../src/execution/apply-executor.js';
import { StateStore } from '../../src/state/store.js';
import { StatePaths } from '../../src/state/paths.js';
import { DependencyGraph } from '../../src/graph/dependency-graph.js';
import { ConnectRestClient, ConnectRestRequest } from '../../src/connect-rest/client.js';
import { loadManifest } from '../../src/manifest/loader.js';
import { PlanEngine } from '../../src/plan/engine.js';
import { buildFakeOrg } from '../support/fake-org-builder.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
describe('Example Data Cloud activation ordering', () => {
  for (const file of ['asset-maintenance.json', 'asset-maintenance-directory']) {
    it(`${file}: finishes the first shared-target activation before creating the second`, async () => {
      const manifest = await loadManifest(join(root, 'examples', file));
      const graph = DependencyGraph.build(manifest);
      const folder = await mkdtemp(join(tmpdir(), 'activation-order-'));
      try {
        const store = new StateStore(new StatePaths(folder, 'test-org', 'default'));
        const state = await store.init({
          orgId: 'test-org',
          instanceUrl: 'https://example.invalid',
          targetOrgAlias: 'test-org',
          dataSpace: 'default',
        });
        const server = buildFakeOrg(manifest);
        const outbound: ConnectRestRequest[] = [];
        const events: string[] = [];
        let provisioning: string | undefined;
        const client: ConnectRestClient = {
          request: async <T>(request: ConnectRestRequest): Promise<T> => {
            outbound.push(request);
            if (request.method === 'POST' && request.path === '/ssot/activations') {
              if (provisioning) throw new Error('Failed to getOrCreate audience dmo latest');
              provisioning = String((request.body as Record<string, unknown>).name);
              events.push(`create:${provisioning}`);
            }
            const result = await server.request<Record<string, unknown>>(request);
            if (
              request.method === 'GET' &&
              request.path.startsWith('/ssot/activations/') &&
              result.status === 'ACTIVE' &&
              provisioning
            ) {
              events.push(`active:${provisioning}`);
              provisioning = undefined;
            }
            return result as T;
          },
        };
        const plan = await new PlanEngine({ manifest, graph, state, ctx: { client } }).compute();
        const result = await new ApplyExecutor({ manifest, graph, state, plan, store, ctx: { client } }).run();
        expect(result.failure, result.failure?.error.message).to.be.undefined;
        expect(
          outbound.filter((request) => request.method === 'POST' && request.path === '/ssot/activations')
        ).to.have.length(2);
        expect(events).to.deep.equal([
          'create:high_value_accounts_activation',
          'active:high_value_accounts_activation',
          'create:recently_active_accounts_activation',
          'active:recently_active_accounts_activation',
        ]);
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });
  }
});
