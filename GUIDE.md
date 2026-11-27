# Using the `data360-iac` CLI

A step-by-step guide to installing, authenticating, and running `sf data360` commands against a
manifest. For the full command/flag reference, run `sf data360 --help` or
`sf data360 <command> --help` — this guide covers the day-to-day workflow.

The plugin uses the Salesforce Data 360 Connect REST API. Supported operations and feature
availability vary by target environment; see [API_NOTES.md](API_NOTES.md) for compatibility
notes. Examples contain synthetic configuration and public standard schema names.

## 1. Install

From inside this project directory:

```bash
yarn install --frozen-lockfile --ignore-scripts
```

Run commands in dev mode, no build step required:

```bash
./bin/dev.js data360 --help
```

Or link it into your own `sf` CLI so you can type `sf data360 ...` directly:

```bash
sf plugins link .
sf data360 --help
```

(Swap `./bin/dev.js data360` for `sf data360` in every example below if you've linked the plugin.)

## 2. Authenticate

The plugin does no OAuth of its own — it rides on your existing `sf` auth:

```bash
sf org login web --alias data360-prod
sf config set target-org=data360-prod   # optional: sets the default so you can omit -o
```

Every org-touching command accepts `-o/--target-org <alias>`, falling back to the configured
default org if omitted.

## 3. Write a manifest, or use one of the examples

A manifest is one JSON file (or a directory of them) describing every resource for a use case.
This repo ships ready-to-use manifests in [examples/](examples/) so you can test every command
without writing one yourself — see [examples/README.md](examples/README.md) for what each one
demonstrates:

| File                                                                                           | Use it for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [examples/minimal-connection.json](examples/minimal-connection.json)                           | A single `Connection` — the fastest sanity check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [examples/asset-maintenance.json](examples/asset-maintenance.json)                             | The full worked example as one file: 26 declared resources plus 5 `kind: "data"` lookups of real Salesforce standard DMOs — three real `IngestApi` connections/streams (Account, Vehicle, Vehicle Telematics Event) feeding the real `ssot__Account__dlm`/`ssot__Vehicle__dlm`/`ssot__VehicleTelematicsEvent__dlm` (plus two secondary) standard DMOs, through data model, intelligence (identity resolution producing the real `UnifiedAccount__dlm` DMO), a data governance flow (tagging, classification, masking) across four of the five governance types (no `ObjectAccessGrant` — see the Troubleshooting note on `permissionSetName`), two segments and two activations built on the Unified Account DMO. Confirmed end-to-end against a live org. |
| [examples/asset-maintenance-directory/](examples/asset-maintenance-directory/)                 | The same 31 blocks split across five files — pass the directory to `-f` instead of a file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [examples/customer-service-data-reference.json](examples/customer-service-data-reference.json) | A second manifest referencing a standard DMO as a `kind: "data"` block.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

This guide uses `examples/asset-maintenance.json` in every example below — swap in your own
manifest once you're comfortable with the workflow. Minimal shape, for reference:

```json
{
  "useCase": "asset-maintenance",
  "dataSpace": "default",
  "resources": [
    {
      "kind": "resource",
      "type": "Connection",
      "name": "account",
      "properties": {
        "connectorType": "IngestApi",
        "name": "account",
        "label": "Account"
      }
    },
    {
      "kind": "resource",
      "type": "DataStream",
      "name": "account_stream",
      "properties": {
        "name": "account_stream",
        "label": "Account Stream",
        "connectionId": "${Connection.account.id}",
        "datastreamType": "INGEST_API",
        "dataAccessMode": "Ingest",
        "connectorInfo": {
          "connectorType": "IngestApi",
          "connectorDetails": { "name": "${Connection.account.apiName}", "events": ["account_dlo"] }
        },
        "dataLakeObjectInfo": {
          "label": "Account DLO",
          "name": "account_dlo",
          "category": "Profile",
          "dataspaceInfo": [{ "name": "default" }],
          "dataLakeFieldInputRepresentations": [
            { "name": "accountId", "label": "Account ID", "dataType": "Text", "isPrimaryKey": true }
          ]
        },
        "mappings": [],
        "refreshConfig": { "refreshMode": "UPSERT" }
      }
    }
  ]
}
```

See [examples/asset-maintenance.json](examples/asset-maintenance.json) for the supported example
shape of a complete `IngestApi` connection + stream, including every field this adapter needs
beyond the minimum shown here.

Key points:

- `kind: "resource"` (default) means the tool creates/updates/destroys it. `kind: "data"` means
  it's a read-only lookup against something that already exists — use this to reference a
  resource another manifest owns, instead of redeclaring it.
- `${Type.name.field}` interpolates another block's id or other output (e.g. an async job's
  result) — no manual dependency list needed. Add an explicit `"dependsOn": ["Type.name"]` only
  when an ordering constraint doesn't show up as a literal field reference.
- Credentials go through `$secret`, never as plaintext:
  ```json
  "secretAccessKey": { "$secret": { "source": "env", "key": "FLEET_S3_SECRET_ACCESS_KEY" } }
  ```
- A directory of `.json` files is merged into one manifest — every file must declare the same
  `useCase` and `dataSpace`, and logical names must be unique across the whole set.
- `connectorType` picks one of five real request schemas for `Connection` (see
  [API_NOTES.md](API_NOTES.md)). The examples use `IngestApi`
  (no extra fields needed). If you instead connect to a CRM org, use `SalesforceDotCom`, which
  additionally needs `organizationId` (the 15- or 18-character id of the Salesforce org Data
  Cloud is attached to — found via `sf org display -o <alias>`'s `Id` field, or `sf data360
discover`'s `Connections/connections.json` if one already exists).

## 4. The core workflow

```bash
# 1. Static checks — no auth, no API calls. Run this on every save.
sf data360 validate -f examples/asset-maintenance.json

# Try the directory-split version too — same 19 resources, same result:
sf data360 validate -f examples/asset-maintenance-directory

# 2. One-time per (org, Data Space): sets up local state.
sf data360 init -o data360-prod --data-space default

# 3. See what would change.
sf data360 plan -f examples/asset-maintenance.json -o data360-prod

# 4. Apply it.
sf data360 apply -f examples/asset-maintenance.json -o data360-prod
```

New to the CLI? Start smaller — run the same four steps against
[examples/minimal-connection.json](examples/minimal-connection.json) first, which only declares a
single `Connection`, before moving on to the full manifest.

`plan` always starts with a refresh pass (re-checking every already-tracked resource against the
live org), then diffs the manifest against state and classifies each resource as `create`,
`update-in-place`, `replace` (flagging downstream resources that will be affected), or `no-op`.

`apply` walks the dependency graph in topological order, running independent resources in
parallel (default concurrency 5), waiting on async jobs (ingestion runs, identity resolution,
calculated insight processing, segment qualification, activation runs) to reach a terminal state,
and writing state after **each individual resource** — so a failure partway through never
requires starting over. Re-running `apply` after a failure picks up exactly where it left off.

Each async job is polled on a fixed 2-second interval (no backoff) until its status is correct,
with every poll's status printed live — so a long-running job (e.g. an identity resolution match
job against a large source population) shows its progress the whole time instead of going silent
after a single "waiting for job to complete" line.

By default `apply` prompts for confirmation before running. Flags:

| Flag                | What it does                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--auto-approve`    | Skip the confirmation prompt — needed in CI.                                                                                                                                 |
| `--step`            | Pause for confirmation after each of the seven stages (Connections → Ingestion → Data Model → Intelligence → Governance → Segmentation → Activation).                        |
| `--adopt`           | If the manifest references something that already exists live in the org, adopt it into state automatically instead of prompting (or failing, in a non-interactive session). |
| `--planfile <path>` | Apply a plan you already reviewed and saved with `plan --out`, instead of recomputing one.                                                                                   |

### Adoption

If a resource block's `name` (or, for resources keyed by `apiName` instead, like Segment and
CalculatedInsight, its `apiName` -- or, for `IdentityResolutionRuleset`, its `label`, the only
identifying field it has) matches something that already exists in the org but isn't yet tracked
in state, `plan` calls it out as an **adoption candidate** rather than a plain create.

- Interactive session: `apply` prompts you to confirm adopting it.
- Non-interactive (CI) session without `--adopt`: `apply` fails rather than silently taking
  ownership of something it didn't create — run `sf data360 import` first, or pass `--adopt`.
- A resource type with none of `name`/`apiName`/`label` as a manifest property can't be
  adoption-detected at all -- `plan` reports it as a fresh `create`, which then fails live with a
  duplicate error if one secretly already exists. If this happens, either `sf data360 state rm`
  the stale tracked entry and re-`apply` (recreating it), or delete the live resource directly and
  re-`apply`.

### Tearing down

```bash
sf data360 destroy -f examples/asset-maintenance.json -o data360-prod
```

Destroys everything tracked in state, in exactly the reverse of the apply order — including a
resource that's since been renamed or removed from the manifest entirely (anything `plan` would
list under "Destroys" as no longer declared). Any resource with `"protect": true` in its
properties is refused — add that flag to any block in your own manifest to guard it. Remove the
flag first if you really mean to destroy it, the same discipline as Terraform's
`prevent_destroy`. By default it prompts for confirmation, same as `apply` — pass
`--auto-approve` to skip the prompt (needed in CI, or when piping input non-interactively).

## 5. Other commands

```bash
# Bring an object that already exists in the org under management, without a manifest entry.
sf data360 import -t DataModelObject -n account_dmo --api-name Account_DMO -o data360-prod

# Sync state's view of tracked resources from the live org (no manifest, no diff).
sf data360 refresh -o data360-prod

# Inspect or repair state directly.
sf data360 state list -o data360-prod
sf data360 state show DataModelObject.account_dmo -o data360-prod
sf data360 state rm DataModelObject.account_dmo -o data360-prod

# Visualize the dependency graph.
sf data360 graph -f examples/asset-maintenance.json --format dot | dot -Tpng -o graph.png
sf data360 graph -f examples/asset-maintenance.json --format json

# Snapshot the live shape of an org -- every list-able Connect REST endpoint, not just the
# resource types this plugin manages -- to JSON files, grouped by API category.
sf data360 discover -o data360-prod -d ./data360-discovery
```

To see how a second use case can declare governance against a standard DMO without creating it,
look at [examples/customer-service-data-reference.json](examples/customer-service-data-reference.json)
— its `kind: "data"` block looks up a DMO live rather than trying to create it. **Note:** update
its lookup name (currently the placeholder `Account_DMO__dlm`) to a real standard DMO, e.g.
`ssot__Account__dlm`, before running `plan`/`apply` against a live org.

## 6. Where state lives

Running `init` creates, in your current directory:

```
.data360/
  config.json
  plans/                                        # saved plan output from `plan --out`
data360.<org-alias>.<data-space>.state.json      # the visible private local state — do not commit
data360.<org-alias>.<data-space>.state.json.backup
data360.<org-alias>.<data-space>.state.json.lock  # present only during an in-flight apply/destroy/import
```

State is shared per (org, Data Space) — every manifest you apply against the same org/space reads
and writes the same state file, which is how a second manifest can later reference a resource the
first one created (as a `data` block) without redeclaring it. The state file stays local and is excluded by `.gitignore`. Version-control reviewed manifests,
not private org state or discovery snapshots.

## 7. Flags every org-touching command accepts

| Flag                       | Meaning                                                   |
| -------------------------- | --------------------------------------------------------- |
| `-o, --target-org <alias>` | Which org to target. Falls back to `sf config`'s default. |
| `--data-space <name>`      | Which Data Space within that org (default: `"default"`).  |
| `--json`                   | Machine-readable output, for scripting.                   |

## 8. Exit codes

| Code | Meaning                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| `0`  | Success (or, for `plan` without `--detailed-exitcode`, "no pending changes").                                |
| `1`  | Error/failure.                                                                                               |
| `2`  | `plan --detailed-exitcode` only: the command succeeded but there are pending changes — useful for CI gating. |

## Troubleshooting

Check the command help, target org permissions, API version, and [API_NOTES.md](API_NOTES.md).
Use read-only requests to verify resource identity and lifecycle status after a timeout.
Collection absence alone is not proof of deletion. Keep diagnostics and discovery output
private: they can contain org configuration even when no credentials are present.

## Resuming a ruleset after a lost create response

A timeout does not prove that creation failed. Confirm the identified ruleset and its declared
configuration using read-only API calls before repairing local tracking. A recovered ruleset
that is still publishing must have a pending lifecycle checkpoint, rather than be reported as
fully applied. The CLI prints `Pending lifecycle` alongside its plan warnings.

On the next approved `apply`, a pending checkpoint resumes from the recorded ID: it does not
create or update the definition again. Publication readiness still uses `rulesetStatus:
PUBLISHED`; the full matching job's `lastJobStatus` does not block the rest of apply. The existing
`run-now` action is then dispatched once. Local state is persisted before action dispatch and
after its acknowledgement. If the action's response or confirmation persistence is lost, the
checkpoint remains uncertain and further apply writes are blocked. Inspect the remote job;
do not clear tracking or repeat `run-now` merely because its response timed out.

If acknowledgement was persisted but the final state commit was interrupted, apply completes
the local checkpoint without sending the action again. Changing or removing the pending
resource in the manifest requires restoring its original intent before resuming. The versioned operation journal records each remote mutation independently, including schema
registration, definition writes, and lifecycle actions. These checkpoints preserve lifecycle
progress while the journal prevents an unresolved write from being replayed.

### Shared Data Cloud activation targets

The asset-maintenance examples order `recently_active_accounts_activation` after
`high_value_accounts_activation` because they share the target's audience DMOs. The existing
executor waits for the first activation to become `ACTIVE` before starting the second create.
This avoids overlapping audience provisioning in the tested failure scenario. It is a
conservative workaround for an observed `Failed to getOrCreate audience dmo latest` error;
the server-side cause remains unverified. Do not add an automatic POST retry for that error.
Inspect the target and any activation created by the failed request before reviewing another
apply. A missing entry in a filtered list does not prove that no partial write occurred.

### Uncertain deletions

A timed-out DELETE is an uncertain write, not permission to issue another DELETE. The client
now retries eligible GETs only. Destroy persists a `deletionPending` checkpoint before dispatch
and retains it if the outcome cannot be confirmed. For activation targets, even a successful
DELETE response is followed by a member GET; state is removed only after documented 404 absence.
An `ACTIVE` response or a permission failure leaves the target tracked and blocks further writes.

Inspect pending deletions without sending any mutations:

```sh
sf data360 destroy -f examples/asset-maintenance.json -o my-org --reconcile-only --json
```

This mode checks recorded identities, repairs local tracking only when absence is confirmed,
and leaves unrelated resources untouched. Unresolved outcomes return `UNCERTAIN_DELETE` with
structured pending resource details. `--auto-approve` does not bypass reconciliation. Apply also
refuses new writes while a delete checkpoint is unresolved. If a target remains present, inspect
its service-side cleanup and request diagnostics; do not erase tracking or the checkpoint to
force a retry. Successful legacy delete acknowledgements for other resource types retain their
existing acknowledgement contract. AccessPolicy deletion additionally requires exact live
cascade review and parent/child absence confirmation.

Standalone `AccessPolicyRule` deletion returns `UNSUPPORTED_DELETE`. Removal and replacement
are blocked before execution unless the parent is explicitly deleted in a reviewed cascade.
The parent is never deleted as an automatic workaround. `state rm` removes tracking only and
reports `remoteDeleted: false`.

When a delete is accepted but teardown is still running, the CLI polls read-only status at a
fixed two-second interval (up to 15 reads and a 30-second polling budget; an in-flight bounded
GET may finish after that budget). Status changes are printed. `DELETE_IN_PROGRESS` means the
server is still deleting; keep tracking and use `--reconcile-only` to resume confirmation.
That command does not repeat DELETE. For identity resolution, the SDK's recorded-ID-specific
`ITEM_NOT_FOUND` response also confirms absence even if the SDK omits the numeric HTTP status.
Permission errors and unrelated not-found messages remain unresolved.

### Mutation deadlines and deletion diagnostics

Org-touching CLI commands keep the 15-second GET deadline and bounded read retries, but allow
one 60-second attempt for a mutation. No automatic write retry is introduced. A timeout still
has an uncertain result; a longer deadline does not prove rollback or permit replay.

Pending deletion details include a safe `lastFailure` classification when captured. Raw error
bodies, request bodies, credentials and resolved secrets are excluded. Older checkpoints do not
contain the discarded error, so its cause cannot be reconstructed from an `ACTIVE` observation.
A mapping that remains `ACTIVE` with its declared fields retains tracking and blocks new writes.
`--reconcile-only` can confirm a mapping's absence using its recorded-name-specific `NOT_FOUND`
response; a different name, permission error or unrelated error remains unresolved.

## Scaffolding an existing selection

```sh
sf data360 scaffold --from-discovery ./data360-discovery \
  --select CalculatedInsight:VehicleHealthScore__cio \
  --use-case existing-assets --data-space default --out ./generated/manifest.json

sf data360 scaffold -o my-sandbox --select DataStream:RECORD_ID \
  --use-case existing-assets --data-space default --out ./generated/manifest.json --json
```

Exactly one source is required: `--from-discovery` or `--target-org` (`-o`). Offline mode
never authenticates or contacts an org. `--select Type:identifier` is repeatable, `--use-case`
and `--out` are required, `--data-space` defaults to `default`, and `--overwrite` explicitly
permits replacing existing outputs. Both modes support `--json`. The report is `<out>.report.json`.
Ambiguous selectors and missing required configuration produce `SCAFFOLD_BLOCKED`, a report,
and no new manifest. Secret leaves become stable env `$secret` references; their values remain
required and are never resolved by scaffolding.

Selected roots propose management. Dependencies are `kind: "data"`; standard DMOs remain
read-only. A stream-owned DLO is referenced through `${DataStream.logicalName.dlApiName}`,
not a second managed DLO. Scaffolding does not import, adopt, refresh state, acquire ownership,
or process resources. Existing import/adoption approval remains required. SQL is decoded once
when necessary, otherwise preserved; only explicit recognised entity fields are rewritten.
The SQL dependency parser recognises plain FROM/JOIN names ending in `__dll`, `__dlm` or
`__cio`, while ignoring comments and string literals. Unsupported source syntax blocks export;
complex or dynamic SQL needs manual reconstruction.

State is shared by org and Data Space. A generated selection is a subset, not an isolated
workspace. The report lists omitted tracked resources when scoped state is available. Review
**every destroy action** before applying a partial manifest against shared state. Inventory
limits, missing metadata and inaccessible endpoints remain visible; collection absence is
not a claim of complete inventory. Older discovery directories often lack source metadata. New `discover` runs write `source.json`
with the authenticated org and requested Data Space; they also include readable AccessPolicy
member/rule configuration. DMO-scoped mapping fan-out snapshots retain their original scope limits.

Tested support is limited to the following fixture shapes (local fake-transport evidence):

| Resource                  | Tested conversion                                                                                            | Limits                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Connection                | IngestApi name, preserved label and connector type                                                           | Other connector management shapes block                                   |
| DataStream                | Complete IngestApi schema/events, source fields, recordId identity                                           | Sparse GETs lacking the original event/schema name block                  |
| DataModelObject           | Standard/shared data lookup, including direct-by-name GET                                                    | No claim of exhaustive collection inventory                               |
| DataModelObjectMapping    | objectSourceTargetMaps envelope; fieldMappings → fieldMapping; entity references                             | Missing entity/configuration blocks                                       |
| CalculatedInsight         | collection.items; unsuffixed manifest apiName, real suffixed outputs; schedule/Data Space/HTML normalisation | SQL dependency scope is limited as described above                        |
| IdentityResolutionRuleset | label, readable match/reconciliation definition; verified Account casing                                     | Does not wait for the matching job or infer missing ruleset configuration |
| Activation                | contactPointEntityName → entityName; fieldConfig → attributes; queryPaths wrappers; sourcesConfig            | Unsupported wrappers or incomplete PUT configuration block                |
| AccessPolicy              | Name, label, description; readable parent rules retained in discovery scope                                  | Rules are separate resources                                              |
| AccessPolicyRule          | Complete readable GET/upsert configuration                                                                   | No standalone deletion API                                                |

Segment and ActivationTarget are supported as read-only dependencies. Other managed shapes
are explicitly blocked. Fixtures for all eight managed types round-trip together through
scaffolding, graph validation, clean adoption, and unchanged apply with zero mutation requests.
These tests do not establish live-org verification of the new command.

## Managed fields and state migration

State format `2.0` reads legacy `1.0` without inventing historical ownership. New entries retain
safe last-applied intent, managed paths and protection; secret descriptors are retained, never
resolved values. Backups and locks remain in use. For a legacy baseline, first review a fresh
plan, then run `apply -f manifest.json -o my-org --baseline-intent` (with explicit normal
approval, or `--auto-approve` after review). This records current declared fields locally;
it cannot reconstruct fields omitted before the baseline.

Live-only fields that have never been declared are unmanaged. Previously managed fields omitted
from a new manifest request removal. They block unless the adapter supplies a verified clear/reset
contract. Explicit null is also a clear request and blocks without verified support. No real
adapter currently advertises an unverified reset value. Required and immutable fields retain
replacement rules. PUT updates preserve readable declarable configuration and block when a safe
complete payload cannot be built. Object comparison is structural; arrays remain ordered except
verified schema/mapping collections with adapter-specific semantics. Tool control `protect` is
kept out of wire properties and is persisted locally.

Unreadable/generated identity fields and secret references are reported as unknown observations.
Previous intent detects changed references. Rotation behind an unchanged secret reference cannot
be reliably detected; literal credentials are redacted from retained intent and cannot establish
fully known historical ownership. Prefer `$secret` descriptors.

Saved plans are version `2`, bound to org, Data Space, lineage, state serial and manifest content.
Older, stale, mismatched or changed-safety plans are rejected. Executing a plan file also requires
`--manifest` so its original intent can be checked.

## Exact AccessPolicy cascade approval

```sh
sf data360 destroy -f manifest.json -o my-org --review-out ./deletion-review.json --json
sf data360 destroy -f manifest.json -o my-org --review-file ./deletion-review.json \
  --approve-cascade SCOPE_HASH --auto-approve --json
```

The read-only review enumerates all rules from the verified parent member GET, including
untracked rules, and records the exact scope hash. Protected rules block deletion. Incomplete
or inaccessible inventories block. `--approve-cascade` is repeatable for multiple parents;
generic `--auto-approve` never approves an absent or expanded scope. Inventory is rechecked
before execution and again immediately before parent dispatch. Changed scope needs a new review.
Apply removals/replacements use the same review in the saved plan and the same scope-hash flag.

Children remain tracked until parent deletion and all reviewed child absences are confirmed.
Uncertain or failed deletion retains the parent, child records and recorded cascade inventory.
Use `destroy --reconcile-only` for read-only confirmation after asynchronous teardown. Tracking
removal is a separate operation and never deletes remote resources.

## Operation recovery

Journals are version `1`, stored privately under ignored `.data360/operations/`, keyed by
canonical org identity and Data Space and guarded by an exclusive scope lock. Each mutation
records original safe intent, fingerprint/normalisation version, plan identity, state serial,
known identity, scoped lookup keys/pre-operation identifiers, phases, timestamps, safe failure
classification and acknowledged identifiers. Wire bodies, raw errors, raw-secret hashes and
resolved credentials are excluded. Atomic fsync/rename publication and rotated backups preserve
records. Preserve corrupt journals; do not substitute an older backup as evidence that a
possibly dispatched operation never happened.

```sh
sf data360 operations -o my-org --json
sf data360 operations -o my-org --reconcile --json
# When the original create response lost its ID: explicitly verify and approve a known ID.
sf data360 operations -o my-org --bind-identity OPERATION_ID=REMOTE_ID --reconcile --json
```

Recovery uses the recorded intent, never a changed manifest. Known IDs are read and compared;
deletes require authoritative absence. Candidate lookup is bounded and read-only. Label equality,
an empty/incomplete list, delayed visibility, permission failures and ambiguous candidates never
authorise another create. When no ID or complete pre-operation ownership evidence exists,
confirmation needs an explicitly verified identity; known pre-existing candidates are rejected.
Conflicting configuration/scope/state version pauses recovery. A confirmed write repairs local
state without replay; a prepared record with no durable dispatch can be rejected locally.

A crash in `dispatching` is uncertain even if the request never left the process. Successful
schema registration remains recorded if stream creation later fails. Identity ruleset definition
and `run-now` have separate records; definition readiness uses `rulesetStatus: PUBLISHED`, not
`lastJobStatus`. An uncertain action has no verified completion evidence contract and remains
blocked: do not infer completion from unchanged configuration or repeat it. The transport timeout
does not cancel or roll back the server operation, and APIs do not provide a verified exactly-once
contract. No new CalculatedInsight run, Segment publish, or Activation full-refresh is added.
