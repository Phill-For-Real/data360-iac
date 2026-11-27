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
import { mkdir, open, readFile, rename, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConnectRestClient, ConnectRestRequest } from '../connect-rest/client.js';
import { isRejectedDependencyDelete } from '../retry/deletion-contract.js';
import { safeIntent } from '../plan/safe-intent.js';
import { computePropertiesHash, stableStringify } from '../plan/properties-hash.js';
import { StatePaths } from './paths.js';
import { StateLock } from './lock.js';
import { StateFile } from './types.js';

export type OperationIntent = {
  key: string;
  type: string;
  intent: Record<string, unknown>;
  planId: string;
  operation: 'create' | 'update' | 'delete' | 'action' | 'schema-upsert';
  remoteId?: string;
  lookup?: Record<string, unknown>;
  protected?: boolean;
  dependencies?: string[];
  preOperationIds?: string[];
  preOperationComplete?: boolean;
};
export type OperationRecord = OperationIntent & {
  version: 1;
  operationId: string;
  phase: 'prepared' | 'dispatching' | 'uncertain' | 'confirmed' | 'committed' | 'rejected';
  orgId: string;
  dataSpace: string;
  lineage: string;
  stateSerial: number;
  replayContract: 'none' | 'rejected-dependency-delete';
  fingerprint: string;
  normalisationVersion: 1;
  method: string;
  path: string;
  preparedAt: string;
  updatedAt: string;
  responseIdentifiers?: Record<string, string>;
  reconciliation?: string;
  failure?: { code: 'REQUEST_TIMEOUT' | 'UNKNOWN_ERROR'; timeoutMs?: number };
};
type JournalFile = { version: 1; records: OperationRecord[] };
export class RecoveryRequiredError extends Error {
  public readonly code = 'RECOVERY_REQUIRED';
  public constructor(public readonly operations: OperationRecord[]) {
    super(
      'Pending remote operations require read-only recovery: run data360 operations --reconcile. No mutation will be replayed.'
    );
    this.name = 'RECOVERY_REQUIRED';
  }
}
/** Atomic, fail-closed journal. Only unresolved manifest intent and safe identifiers are stored;
 * wire bodies, raw errors and resolved credentials never enter this store. */
export function journalFor(storePaths: StatePaths, state: StateFile): OperationJournal {
  const scope = computePropertiesHash({
    orgId: state.orgFingerprint.orgId,
    dataSpace: state.orgFingerprint.dataSpace,
  }).slice(7);
  return new OperationJournal(join(storePaths.configDir, 'operations', `${scope}.journal.json`), state);
}
export class OperationJournal {
  private readonly lock: StateLock;
  private paused = false;
  private serial: number;
  private queue: Promise<void> = Promise.resolve();
  public constructor(public readonly file: string, private readonly state: StateFile) {
    this.lock = new StateLock(`${file}.lock`);
    this.serial = state.serial;
  }
  public async acquire(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await this.lock.acquire();
  }
  public async release(): Promise<void> {
    await this.lock.release();
  }
  public async bindIdentity(operationId: string, remoteId: string): Promise<void> {
    await this.mutate((records) =>
      records.map((r) =>
        r.operationId === operationId
          ? {
              ...r,
              remoteId,
              reconciliation:
                'Remote identity explicitly bound by user for read-only comparison; no mutation authorised.',
            }
          : r
      )
    );
  }
  public async confirmDeletion(key: string): Promise<void> {
    await this.mutate((records) =>
      records.map((r) =>
        r.key === key && r.operation === 'delete' && r.phase !== 'committed' ? { ...r, phase: 'confirmed' } : r
      )
    );
  }
  // eslint-disable-next-line complexity -- fail closed for scope, phases, metadata and non-secret intent integrity.
  public async read(): Promise<OperationRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    let data: JournalFile;
    try {
      data = JSON.parse(contents) as JournalFile;
    } catch {
      throw new Error(
        'Recovery journal is corrupt; preserve it and inspect its backup; do not treat an older backup as proof that no request was dispatched.'
      );
    }
    if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('Incompatible recovery journal.');
    for (const record of data.records) {
      if (
        record.version !== 1 ||
        !record.operationId ||
        !record.intent ||
        !['prepared', 'dispatching', 'uncertain', 'confirmed', 'committed', 'rejected'].includes(record.phase)
      )
        throw new Error('Invalid recovery operation.');
      if (
        record.orgId !== this.state.orgFingerprint.orgId ||
        record.dataSpace !== this.state.orgFingerprint.dataSpace ||
        record.lineage !== this.state.lineage
      )
        throw new Error('Recovery journal scope or state lineage mismatch.');
    }
    if (new Set(data.records.map((r) => r.operationId)).size !== data.records.length)
      throw new Error('Duplicate recovery operation IDs.');
    for (const record of data.records) {
      if (
        record.normalisationVersion !== 1 ||
        !Number.isInteger(record.stateSerial) ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(record.method) ||
        typeof record.path !== 'string'
      )
        throw new Error('Invalid recovery operation metadata.');
      if (
        stableStringify(record.intent) !== stableStringify(safeIntent(record.intent)) ||
        record.fingerprint !== computePropertiesHash(record.intent)
      )
        throw new Error('Recovery intent fingerprint is invalid or contains unsafe literal credentials.');
    }
    return data.records;
  }
  public async pending(): Promise<OperationRecord[]> {
    return (await this.read()).filter((r) => r.phase !== 'committed' && r.phase !== 'rejected');
  }
  public async assertReady(): Promise<void> {
    const records = await this.pending();
    if (records.length) throw new RecoveryRequiredError(records);
  }
  public async prepare(intent: OperationIntent, request: ConnectRestRequest): Promise<OperationRecord> {
    if (this.paused) throw new RecoveryRequiredError(await this.pending());
    const now = new Date().toISOString();
    const record: OperationRecord = {
      ...intent,
      lookup: intent.lookup ? (safeIntent(intent.lookup) as Record<string, unknown>) : undefined,
      replayContract: request.replayContract ?? 'none',
      intent: safeIntent(intent.intent) as Record<string, unknown>,
      version: 1,
      operationId: randomUUID(),
      phase: 'prepared',
      orgId: this.state.orgFingerprint.orgId,
      dataSpace: this.state.orgFingerprint.dataSpace,
      lineage: this.state.lineage,
      stateSerial: this.serial,
      fingerprint: computePropertiesHash(safeIntent(intent.intent) as Record<string, unknown>),
      normalisationVersion: 1,
      method: request.method,
      path: request.path,
      preparedAt: now,
      updatedAt: now,
    };
    await this.mutate((records) => {
      if (records.some((r) => r.phase === 'uncertain'))
        throw new RecoveryRequiredError(records.filter((r) => r.phase === 'uncertain'));
      return [...records, record];
    });
    return record;
  }
  public async phase(
    id: string,
    phase: OperationRecord['phase'],
    details: Partial<Pick<OperationRecord, 'responseIdentifiers' | 'reconciliation' | 'failure'>> = {}
  ): Promise<void> {
    if (phase === 'uncertain') this.paused = true;
    if (phase === 'dispatching' && this.paused) throw new RecoveryRequiredError(await this.pending());
    await this.mutate((records) =>
      records.map((r) => (r.operationId === id ? { ...r, ...details, phase, updatedAt: new Date().toISOString() } : r))
    );
  }
  public async identifyResource(key: string, id: string, apiName?: string): Promise<void> {
    await this.mutate((records) =>
      records.map((r) =>
        r.key === key && r.phase === 'confirmed' && r.operation !== 'action' && !r.path.endsWith('/schema')
          ? { ...r, responseIdentifiers: { ...r.responseIdentifiers, id, ...(apiName ? { apiName } : {}) } }
          : r
      )
    );
  }
  public async stateVersion(serial: number): Promise<void> {
    this.serial = serial;
    await this.mutate((records) =>
      records.map((r) => (r.phase === 'committed' || r.phase === 'rejected' ? r : { ...r, stateSerial: serial }))
    );
  }
  public async commitResource(key: string): Promise<void> {
    await this.mutate((records) =>
      records.map((r) =>
        r.key === key && r.phase === 'confirmed' ? { ...r, phase: 'committed', updatedAt: new Date().toISOString() } : r
      )
    );
  }
  private mutate(fn: (records: OperationRecord[]) => OperationRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      const records = fn(await this.read());
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, records }, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await copyFile(this.file, `${this.file}.backup`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(temporary, this.file);
      const directory = await open(dirname(this.file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
function identifiers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const response = value as Record<string, unknown>;
  return Object.fromEntries(
    ['id', 'recordId', 'apiName', 'name', 'developerName']
      .filter((key) => typeof response[key] === 'string')
      .map((key) => [key, response[key] as string])
  );
}
/** Every adapter request passes through here, including writes inside lifecycle/schema calls. */
export class JournalClient implements ConnectRestClient {
  public constructor(
    private readonly remote: ConnectRestClient,
    private readonly journal: OperationJournal,
    private readonly intent: OperationIntent
  ) {}
  public async request<T>(request: ConnectRestRequest): Promise<T> {
    if (request.method === 'GET') return this.remote.request<T>(request);
    const kind = request.path.includes('/actions/')
      ? 'action'
      : request.path.endsWith('/schema')
      ? 'schema-upsert'
      : this.intent.operation;
    const record = await this.journal.prepare({ ...this.intent, operation: kind }, request);
    await this.journal.phase(record.operationId, 'dispatching');
    try {
      const response = await this.remote.request<T>(request);
      await this.journal.phase(record.operationId, 'confirmed', { responseIdentifiers: identifiers(response) });
      return response;
    } catch (error) {
      if (request.replayContract === 'rejected-dependency-delete' && isRejectedDependencyDelete(error)) {
        await this.journal.phase(record.operationId, 'rejected', {
          reconciliation:
            'Verified DEPENDENCY_EXISTS rejection; the operation-specific replay contract permits bounded retry.',
        });
        throw Object.assign(new Error('Dependency deletion was definitively rejected.'), {
          statusCode: 400,
          errorCode: 'DEPENDENCY_EXISTS',
        });
      }
      const value = error as { timeoutMs?: number; message?: string };
      const timeoutMs =
        value?.timeoutMs ?? (Number(/^Request timed out after (\d+)ms$/.exec(value?.message ?? '')?.[1]) || undefined);
      const failure = { code: timeoutMs ? ('REQUEST_TIMEOUT' as const) : ('UNKNOWN_ERROR' as const), timeoutMs };
      await this.journal.phase(record.operationId, 'uncertain', { failure });
      throw Object.assign(new RecoveryRequiredError([{ ...record, phase: 'uncertain', failure }]), { timeoutMs });
    }
  }
}
