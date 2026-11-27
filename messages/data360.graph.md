# summary

Emit the manifest's dependency graph for visualization.

# description

Loads the manifest, builds the resource reference graph, and prints it as DOT or JSON.

# flags.manifest.summary

Path to a manifest JSON file or a directory of manifest JSON files.

# flags.format.summary

Output format: dot or json.

# examples

- Emit the graph as DOT:

  <%= config.bin %> <%= command.id %> -f asset-maintenance.json --format dot

# info.notImplemented

`data360 graph` is not yet implemented.
