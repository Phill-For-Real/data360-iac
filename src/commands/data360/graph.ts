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
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, SfError } from '@salesforce/core';
import { loadManifest } from '../../manifest/loader.js';
import { DependencyGraph } from '../../graph/dependency-graph.js';
import { toDot, toJson, GraphJson } from '../../graph/export.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('data360-iac', 'data360.graph');

export type Data360GraphResult = GraphJson | { dot: string };

export default class Data360Graph extends SfCommand<Data360GraphResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    manifest: Flags.string({
      char: 'f',
      summary: messages.getMessage('flags.manifest.summary'),
      required: true,
    }),
    format: Flags.option({
      summary: messages.getMessage('flags.format.summary'),
      options: ['dot', 'json'] as const,
      default: 'dot' as const,
    })(),
  };

  public async run(): Promise<Data360GraphResult> {
    const { flags } = await this.parse(Data360Graph);

    let graph: DependencyGraph;
    try {
      const manifest = await loadManifest(flags.manifest);
      graph = DependencyGraph.build(manifest);
    } catch (e) {
      throw SfError.wrap(e);
    }

    if (flags.format === 'json') {
      const json = toJson(graph);
      this.logJson(json);
      return json;
    }

    const dot = toDot(graph);
    this.log(dot);
    return { dot };
  }
}
