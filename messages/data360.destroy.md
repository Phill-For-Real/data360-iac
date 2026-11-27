# summary

Tear down every resource tracked in state for a manifest, in reverse dependency order.

# description

Destroys resources in the reverse of the topological apply order, refusing to remove any resource marked `protect: true` without an explicit override.

# flags.manifest.summary

Path to a manifest JSON file or a directory of manifest JSON files.

# flags.step.summary

Pause for confirmation after each stage.

# flags.auto-approve.summary

Skip the interactive approval prompt before destroying.

# examples

- Destroy everything a manifest declared:

  <%= config.bin %> <%= command.id %> -f asset-maintenance.json -o data360-prod

# info.notImplemented

`data360 destroy` is not yet implemented.
