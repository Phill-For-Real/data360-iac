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
/** Verified dependency-rejection responses establish that this DELETE was rejected, not
 * committed with a lost response. Transport errors and ambiguous statuses never qualify. */
export function isRejectedDependencyDelete(error: unknown): boolean {
  const value = error as { errorCode?: string; statusCode?: number; status?: number; message?: string } | undefined;
  const status = value?.statusCode ?? value?.status;
  if (status !== undefined) return status === 400 && value?.errorCode === 'DEPENDENCY_EXISTS';
  const message = value?.message ?? '';
  return (
    /^Message: DEPENDENCY_EXISTS\nHTTP response code: 400(?:\n|$)/.test(message) ||
    /^DEPENDENCY_EXISTS: Data Lake Object [^\n]+ is referenced elsewhere in Salesforce\. Remove the usage and try again\.$/.test(
      message
    )
  );
}
