# summary

Adopt one existing org object into state and print a starter JSON block for it.

# description

The brownfield onboarding path for a resource the manifest doesn't mention yet: fetches the live object via Connect REST, writes a state entry marked adopted, and prints a ready-to-paste JSON block reproducing its current properties.

# flags.type.summary

The resource type to import (e.g. DataModelObject).

# flags.name.summary

The logical name to give this resource in state.

# flags.api-name.summary

The live object's API name (the lookup key).

# examples

- Import an existing Data Model Object:

  <%= config.bin %> <%= command.id %> -t DataModelObject -n account_dmo --api-name Account_DMO

# info.imported

Imported %s "%s" into state. Starter JSON block:
