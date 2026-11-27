# summary

Scaffold local state/config for a target org and Data Space.

# description

Creates the .data360/ config directory and generates a new state file lineage for the given org and Data Space. Makes no API calls.

# examples

- Initialize state for the default org and the "default" Data Space:

  <%= config.bin %> <%= command.id %> --data-space default

# info.initialized

Initialized state at %s.
