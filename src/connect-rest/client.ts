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
import { Connection } from '@salesforce/core';
import { BackoffPolicy, DEFAULT_BACKOFF_POLICY, retryWithBackoff } from '../retry/backoff.js';

export type ConnectRestMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type ConnectRestRequest = {
  method: ConnectRestMethod;
  path: string;
  body?: unknown;
  replayContract?: 'rejected-dependency-delete';
};

/**
 * The single seam between this plugin and the Data 360 Connect REST API.
 * Every resource adapter talks to the org exclusively through this interface, so that
 * dropping in verified real endpoint/request/response shapes later (see API_NOTES.md)
 * never requires touching adapter or engine logic — only the request bodies/paths passed through it.
 */
export interface ConnectRestClient {
  request<T = unknown>(req: ConnectRestRequest): Promise<T>;
}

/**
 * A raw transport-level failure (DNS/TLS/connection-reset, or Node's `fetch` itself throwing) has
 * no HTTP status at all -- confirmed live, repeatedly, as a bare `fetch failed` Error with no
 * further detail, surfacing from `connection.request()` with no retry of its own underneath. A
 * real status code of 429 or 5xx is also transient (rate limiting / a momentary server fault);
 * anything else (4xx, a real validation error) is a genuine request problem that retrying can't
 * fix.
 */
export function isRetryableConnectRestError(error: unknown): boolean {
  const statusCode =
    (error as { statusCode?: number; status?: number } | undefined)?.statusCode ??
    (error as { statusCode?: number; status?: number } | undefined)?.status;
  if (typeof statusCode === 'number') {
    return statusCode === 429 || statusCode >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out/i.test(message);
}

export class RequestTimeoutError extends Error {
  public constructor(message: string, public readonly timeoutMs?: number) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * `connection.request()` can hang indefinitely with no resolve and no reject -- confirmed live,
 * repeatedly, on a long-running `apply` process (a dead/stale keep-alive socket that Node's
 * `fetch` never surfaces as an error): a single resource's job-status poll sat unresolved for 10+
 * minutes while a brand-new process's identical request against the same org/endpoint succeeded
 * in seconds. A rejecting error (e.g. `fetch failed`) is already retried by `retryWithBackoff`
 * below; a request that never settles at all gives that retry nothing to catch. Racing every real
 * request against this timeout turns a silent hang into a `RequestTimeoutError`. This does not
 * cancel the server operation: a timed-out POST may still have created its resource.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(`Request timed out after ${ms}ms`, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Thin wrapper over an authenticated @salesforce/core Connection's generic request helper.
 *
 * Bounds every request with a timeout and retries transient failures for GET requests. A POST may commit before its response is lost, so replaying it can create duplicates.
 * Resource adapters can reconcile a failed create by looking up the resource instead.
 */
export class RealConnectRestClient implements ConnectRestClient {
  public constructor(
    private readonly connection: Connection,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
    private readonly backoffPolicy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
    /** Called before each retry (not the final failure) -- see `onRetry` below. */
    private readonly onRetry?: (method: ConnectRestMethod, path: string, attempt: number, error: unknown) => void,
    private readonly mutationTimeoutMs: number = timeoutMs
  ) {}

  public async request<T = unknown>(req: ConnectRestRequest): Promise<T> {
    return retryWithBackoff(
      () =>
        withTimeout(
          this.connection.request<T>({
            method: req.method,
            url: req.path,
            body: req.body === undefined ? undefined : JSON.stringify(req.body),
          }),
          req.method === 'GET' ? this.timeoutMs : this.mutationTimeoutMs
        ),
      this.backoffPolicy,
      // Only reads have an automatic replay contract here. A timeout, network failure or 5xx can arrive after the server
      // committed the write; adapters must reconcile that outcome instead of creating twice.
      (error) => req.method === 'GET' && isRetryableConnectRestError(error),
      (attempt, error) => this.onRetry?.(req.method, req.path, attempt, error)
    );
  }
}

export type FakeRequestHandler = (req: ConnectRestRequest) => unknown;

/**
 * In-memory fake used by the entire test suite. Tests register handlers (by exact method+path,
 * or a catch-all) to simulate org state and responses without any network access.
 */
export class FakeConnectRestClient implements ConnectRestClient {
  public readonly calls: ConnectRestRequest[] = [];
  private readonly handlers = new Map<string, FakeRequestHandler>();

  public on(method: ConnectRestMethod, path: string, handler: FakeRequestHandler): void {
    this.handlers.set(`${method} ${path}`, handler);
  }

  public async request<T = unknown>(req: ConnectRestRequest): Promise<T> {
    this.calls.push(req);
    const handler = this.handlers.get(`${req.method} ${req.path}`);
    if (!handler) {
      throw new Error(`FakeConnectRestClient: no handler registered for ${req.method} ${req.path}`);
    }
    return (await handler(req)) as T;
  }
}
