# summary

Statically validate a manifest's resource graph.

# description

Checks schema per resource type, duplicate logical names, unresolved references, and reference cycles. Makes no API calls and requires no auth.

# flags.manifest.summary

Path to a manifest JSON file or a directory of manifest JSON files.

# examples

- Validate a single manifest file:

  <%= config.bin %> <%= command.id %> -f asset-maintenance.json

# info.valid

Manifest is valid: %s resource(s), no unresolved references, no cycles, no duplicate names.
