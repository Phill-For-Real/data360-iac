# summary

Apply a manifest (or a saved plan) to the target org in dependency order.

# description

Executes the topological sort of the resource graph, submitting and polling asynchronous jobs to a terminal state, and writing state after each individual resource completes.

# flags.manifest.summary

Path to a manifest JSON file or a directory of manifest JSON files.

# flags.planfile.summary

Path to a saved plan file (from `plan --out`) to execute instead of computing one inline.

# flags.step.summary

Pause for confirmation after each stage.

# flags.auto-approve.summary

Skip the interactive approval prompt before applying.

# flags.adopt.summary

Automatically adopt any resource that already exists live in the org instead of requiring a prior `import`.

# examples

- Apply a manifest to an org:

  <%= config.bin %> <%= command.id %> -f asset-maintenance.json -o data360-prod

# info.notImplemented

`data360 apply` is not yet implemented.
