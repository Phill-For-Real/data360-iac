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
import { AnyJson } from '@salesforce/ts-types';
import { FakeConnectRestClient, ConnectRestMethod } from '../../src/connect-rest/client.js';

/**
 * Adapts a FakeConnectRestClient to the shape @salesforce/core's TestContext.fakeConnectionRequest
 * expects: it's installed as the stub behind Connection.prototype.request, which RealConnectRestClient
 * calls with { method, url, body } (body pre-stringified). This lets CLI-level e2e tests register
 * handlers once, in the same vocabulary as every unit-level adapter/plan/apply test.
 */
export function asFakeConnectionRequest(client: FakeConnectRestClient): (request: AnyJson) => Promise<AnyJson> {
  return async (request: AnyJson) => {
    const req = request as unknown as { method: ConnectRestMethod; url: string; body?: string };
    const body = req.body === undefined ? undefined : JSON.parse(req.body);
    return client.request<AnyJson>({ method: req.method, path: req.url, body });
  };
}
