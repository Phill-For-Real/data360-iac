# summary

Compute and print the change set between a manifest and the live org.

# description

Refreshes live state of every tracked resource, detects adoption candidates, diffs desired configuration against state, and classifies each resource as create, update-in-place, replace, or no-op.

# flags.manifest.summary

Path to a manifest JSON file or a directory of manifest JSON files.

# flags.step.summary

Pause for confirmation after each stage.

# flags.out.summary

Save the computed plan to .data360/plans/ for later `apply`.

# flags.detailed-exitcode.summary

Return exit code 2 when there are pending changes, instead of 0.

# examples

- Plan changes for a manifest against an org:

  <%= config.bin %> <%= command.id %> -f asset-maintenance.json -o data360-prod

# info.saved

Plan saved to %s.
