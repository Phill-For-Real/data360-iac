# summary

Surgically remove one resource's entry from state without touching the live org.

# flags.name.summary

The logical name of the resource to remove (e.g. DataModelObject.account_dmo).

# examples

- Remove a resource's state entry:

  <%= config.bin %> <%= command.id %> DataModelObject.account_dmo -o data360-prod

# info.removed

Removed "%s" from state.
