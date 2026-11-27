# summary

Snapshot the live state of every list-able Connect REST endpoint to JSON files.

# description

Queries every GET endpoint in the Salesforce Data 360 Connect REST API that can list a collection with no required parameter (not just the resource types this plugin manages), and writes each endpoint's raw response as its own JSON file, grouped into folders matching the API's own categories (Connections, Activations, Data Governance, Machine Learning, and so on). Endpoints that require a parameter this command can't resolve on its own (such as a specific activation or model ID) are skipped and recorded, not guessed at. A `summary.json` in the output directory lists every endpoint's outcome: fetched, skipped, or errored. A `source.json` records the authenticated org and requested Data Space. Readable AccessPolicy member configuration includes its rules for offline scaffolding. Snapshots retain endpoint and completeness limits. Read-only -- makes no changes to the org, the manifest, or local state.

# flags.output-dir.summary

Directory to write the discovered JSON files into. Created if it doesn't exist.

# examples

- Discover the live state of an org into ./data360-discovery:

  <%= config.bin %> <%= command.id %> -o my-org

- Discover into a custom directory:

  <%= config.bin %> <%= command.id %> -o my-org -d ./snapshots/demo

# info.starting

Discovering up to %s endpoints into %s...

# info.fetched

%s Fetched %s/%s (%s items)

# info.skipped

%s Skipped %s/%s (%s)

# info.errored

%s Error on %s/%s: %s

# info.summary

Discovered %s endpoints, skipped %s, errored %s. Written to %s.
