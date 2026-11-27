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
import { RestAdapterBase } from './rest-adapter-base.js';

/**
 * The simpler, connector-style activation destination (e.g. S3), `/ssot/activation-targets`.
 * See ActivationPlatformAdapter for the full-featured, attribute-mapped counterpart
 * (`/ssot/activation-platforms`) -- these are two genuinely distinct real resources. No async
 * job: status settles synchronously ("ACTIVE") in the create response.
 */
export class ActivationTargetAdapter extends RestAdapterBase {
  public constructor() {
    super({
      type: 'ActivationTarget',
      resourcePlural: 'activation-targets',
      listResponseKey: 'activationTargets',
      fieldClassification: {
        platformType: 'replace',
        name: 'replace',
        dataSpaceName: 'replace',
        connector: 'update',
        description: 'update',
      },
      matchesLookupKey: (item, key) =>
        key.masterLabel !== undefined ? item.masterLabel === key.masterLabel : item.name === key.name,
      buildLookupQuery: (key) => {
        const name = (key.masterLabel ?? key.name) as string | number | undefined;
        return { filters: name !== undefined ? `masterLabel in ${name}` : undefined };
      },
    });
  }
}
