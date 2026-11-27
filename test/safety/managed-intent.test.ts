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
import { expect } from 'chai';
import { compareManaged } from '../../src/plan/diff.js';
describe('managed intent', () => {
  it('projects response-only keys within ordered arrays', () => {
    expect(
      compareManaged(
        { fields: [{ name: 'a' }, { name: 'b' }] },
        { fields: [{ name: 'a', status: 1 }, { name: 'b' }] },
        {}
      ).action
    ).to.equal('no-op');
    expect(
      compareManaged({ fields: [{ name: 'b' }, { name: 'a' }] }, { fields: [{ name: 'a' }, { name: 'b' }] }, {}).action
    ).to.equal('update-in-place');
  });
  it('blocks removal and null without a verified contract', () => {
    expect(compareManaged({}, { description: 'old' }, {}, { description: 'old' }).blockers).to.have.length(1);
    expect(compareManaged({ description: null }, {}, {}).blockers).to.have.length(1);
    expect(
      compareManaged({}, { description: 'old' }, {}, { description: 'old' }, { description: null }).action
    ).to.equal('update-in-place');
  });
  it('detects changed secret references without comparing a masked observation', () => {
    const secret = (key: string): Record<string, unknown> => ({ credentials: { $secret: { source: 'env', key } } });
    expect(compareManaged(secret('NEW'), { credentials: '*****' }, {}, secret('OLD')).action).to.equal(
      'update-in-place'
    );
    expect(compareManaged(secret('OLD'), { credentials: '*****' }, {}, secret('OLD')).action).to.equal('no-op');
  });
});
