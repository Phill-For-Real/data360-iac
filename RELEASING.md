# Public source releases

Local org state, backups, locks, authentication, discovery snapshots, and API extraction
output are private development data. `.gitignore` excludes them regardless of org alias or
data space. Keep example credentials as environment variable references and use fictional
identifiers in documentation and tests.

Run `npm run check:public-source` before committing or preparing a release. It checks tracked
and new source files and every index blob for private paths, identifying metadata, org URLs
and IDs, and selected credential formats. Only the established synthetic org IDs in tests
are exempted. Findings omit matched values. The `--history` option also checks all local
reachable Git history and author/committer metadata; GitHub noreply email addresses are
allowed in commit metadata. This targeted check complements a broader secret scanner.

For a public repository derived from a private development checkout, export the reviewed,
committed source tree into an empty directory. Do not copy the development checkout or its
Git history. `.gitattributes` excludes private development notes and extraction utilities
from Git archives. `.gitignore` protects local runtime data, but does not remove tracked
files or scrub earlier commits.

```sh
npm run check:public-source
# Commit reviewed source changes first; uncommitted files are not exported.
git archive --format=tar --output=/tmp/data360-public-source.tar HEAD
```

Extract the archive into an empty directory and initialize a new Git repository there.
The archive contains the committed source tree without `.git`, old commits, ignored local
files, or uncommitted work. Choose the author name and email you intend to publish before
making the new repository's first commit. Retain required license and copyright notices and
confirm publication rights for the included contributions and examples.

For release validation, install with `yarn install --frozen-lockfile --ignore-scripts`.
The Salesforce development install hook can rewrite project configuration with internal
defaults; skipping lifecycle scripts preserves the reviewed public source.

Before uploading the candidate, run:

```sh
node --test scripts/check-public-source.test.mjs
node scripts/check-public-source.mjs --history
gitleaks dir --redact .
gitleaks git --redact --log-opts=--all .
yarn build
CI=true yarn test
```

Review every scanner finding, the exported file inventory, commit identities, and the final
build/test results. If a credential is discovered, revoke or rotate it before publication.
Use a fresh repository with only the reviewed new history. Keep private development history
and runtime data in private storage.

The `Public source safety` workflow runs the metadata guard and checksum-verified Gitleaks
8.30.1 on the source and full reachable history. The `Build and tests` job validates the
plugin. Configure both checks as required on the default branch, enable secret scanning and
push protection where supported, and review any release artifacts separately before upload.

An npm package release is a separate action. Before publishing one, inspect its actual tarball
and generated files for private values, including source maps. Public GitHub source does not
automatically establish that a package artifact is clean.
