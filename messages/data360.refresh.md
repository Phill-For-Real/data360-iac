# summary

Reconcile state's view of tracked resources with the live org.

# description

Standalone reconciliation pass: updates state's recorded properties for every tracked resource from the live org. No manifest and no diff against desired configuration.

# examples

- Refresh state from the live org:

  <%= config.bin %> <%= command.id %> -o data360-prod

# info.refreshed

Refreshed %s tracked resource(s) from the live org.
