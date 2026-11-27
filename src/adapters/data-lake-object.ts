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
import { isRejectedDependencyDelete } from '../retry/deletion-contract.js';
import { retryWithBackoff } from '../retry/backoff.js';
import { RestAdapterBase } from './rest-adapter-base.js';
import { AdapterContext } from './types.js';
import { memberPath } from './real-paths.js';

/**
 * Independently manageable via `/ssot/data-lake-objects` -- not a byproduct of its owning
 * DataStream's run, contrary to the earlier placeholder assumption. Plain, synchronous CRUD;
 * no async job. The real collection endpoint has no name/label filter query param, so lookup()
 * falls back to the base class's list-all-and-match-client-side behavior.
 *
 * **Deleting a `DataTransform` that owns this DLO as its `outputD360` target doesn't
 * synchronously release the reference** -- confirmed live: a `DataTransform` delete that
 * reports success is immediately followed by this DLO's own delete failing with
 * `DEPENDENCY_EXISTS: Data Lake Object <name> is referenced elsewhere in Salesforce. Remove the
 * usage and try again.`; retrying the exact same delete ~5s later succeeds with no other change.
 * `delete()` retries specifically on that message (a real conflict from an actual, unrelated
 * live reference still fails immediately -- only this known, transient same-run teardown race is
 * retried).
 */
export class DataLakeObjectAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'DataLakeObject',
      resourcePlural: 'data-lake-objects',
      listResponseKey: 'dataLakeObjects',
      fieldClassification: {
        name: 'replace',
        category: 'replace',
        dataspaceInfo: 'replace',
        orgUnitIdentifierFieldName: 'replace',
        recordModifiedFieldName: 'replace',
        dataLakeFieldInputRepresentations: 'update',
        label: 'update',
      },
    });
  }

  public async delete(ctx: AdapterContext, id: string): Promise<void> {
    await retryWithBackoff(
      () =>
        ctx.client.request({
          method: 'DELETE',
          path: memberPath(this.resourcePlural, id),
          replayContract: 'rejected-dependency-delete',
        }),
      { initialDelayMs: 2_000, maxDelayMs: 10_000, factor: 2, maxAttempts: 5 },
      isRejectedDependencyDelete
    );
  }
}
