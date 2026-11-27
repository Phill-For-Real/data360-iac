# data360-iac

An `sf` CLI plugin that manages a Salesforce Data 360 environment declaratively from JSON
manifests — the same category of tool as Terraform or AWS CloudFormation, but purpose-built for
the Data 360 Connect REST API. Invoked as `sf data360 <command>`.

**New to this plugin?** See [GUIDE.md](GUIDE.md) for a step-by-step walkthrough: install,
authenticate, write a manifest, and run `validate`/`plan`/`apply`/`destroy`.

For publishing a clean source snapshot in a new repository, see [RELEASING.md](RELEASING.md).

## Status

This plugin supports declarative manifests, dependency planning, local state, apply and
destroy recovery, discovery, and scaffolding against the Salesforce Data 360 Connect REST API.

Supported resources cover connections, ingestion, data models and mappings, transforms,
identity resolution, calculated insights, segmentation, activation, and governance. API
availability and lifecycle restrictions vary by environment. See [API_NOTES.md](API_NOTES.md)
for compatibility notes and [GUIDE.md](GUIDE.md) for workflow and recovery instructions.

Examples use fictional configuration and standard Salesforce schema names. Tests use fake
clients and mock authentication; they do not require access to a Salesforce org.

## Running the plugin

```bash
yarn install --frozen-lockfile --ignore-scripts
```

Run any command in dev mode (no build step needed):

```bash
./bin/dev.js data360 --help
./bin/dev.js data360 validate -f path/to/manifest.json
```

Or build once and use the compiled `lib/` output:

```bash
yarn build
./bin/run.js data360 --help
```

To install into your own `sf` CLI for local development:

```bash
sf plugins link .
sf data360 --help
```

## Running tests

```bash
yarn test:only   # unit + integration tests (mocha)
yarn lint        # eslint
yarn test        # everything: lint, compile, tests, command reference, json schema checks
```

No test in this project requires a live Salesforce org, real credentials, or network access.
Every test runs against `FakeConnectRestClient` ([src/connect-rest/client.ts](src/connect-rest/client.ts))
or the mocked `@salesforce/core` auth store — including [test/e2e/asset-maintenance.e2e.test.ts](test/e2e/asset-maintenance.e2e.test.ts),
which runs the full `validate` → `plan` → `apply` → `plan` (asserting no-op) → `destroy` lifecycle
against the synthetic Asset Maintenance fixture, entirely against fakes.

## Real API wiring

Every adapter in [src/adapters/](src/adapters/) talks to the real Connect REST API exclusively
through `ConnectRestClient` ([src/connect-rest/client.ts](src/connect-rest/client.ts)), and all
implement the same `ResourceAdapter` interface ([src/adapters/types.ts](src/adapters/types.ts)) --
nothing in the manifest loader, dependency graph, state store, plan engine, or executor depends on
any particular resource type's endpoint shape. [API_NOTES.md](API_NOTES.md) tracks
what's verified per resource type and what's still unconfirmed (mostly exact async-job status
string values, which only a real-org smoke test can settle).

## Command reference

See `sf data360 --help` and `sf data360 <command> --help` for full flag documentation. [GUIDE.md](GUIDE.md) describes the command workflow and exit codes.
