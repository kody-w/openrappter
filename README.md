# RAPP Work

Serious local AI for real business work.

RAPP Work is a desktop workspace for persistent agents, assigned work,
reviewable approvals, and evidence-backed results. It supports **macOS on Apple
Silicon**. Node.js 22 or newer is required for source development.

## The product

- **Work** — tasks, runs, approvals, results, and their evidence.
- **Agents** — persistent worker definitions with private agent workspaces.
- **Automations** — agent-owned scheduled work with explicit policy.
- **Settings** — provider setup, computer status, and diagnostics.

Each agent owns its durable state. RAPP/1 frames are the event authority;
projections and caches are rebuildable. Resource IDs locate data but do not grant
permission. Business tools run only in the shared, host-owned Omarchy guest.
The host controls that computer through fixed application-owned operations,
not a general-purpose shell for agents.

An unavailable provider or computer is shown as unavailable. Missing
persistence or an unverified write-ahead intent prevents execution. An uncertain
outcome remains unresolved and is never automatically replayed.

## Source workspace

```text
apps/desktop             Electron desktop and packaging
apps/host                authenticated local composition and RPC
apps/ui                  Work, Agents, Automations, Settings
packages/rapp1           canonical authority, frames, scanning and evidence
packages/rapp1/fixtures  canonical checkpoint and wire fixtures
packages/workspace-store private per-agent state and atomic committed writes
packages/security        capabilities, approvals and scoped execution permits
packages/domain          domain records and reducers
packages/work-service    verified command and projection orchestration
packages/agent-runtime   persistent workers and bounded execution
packages/model-provider provider boundary
packages/computer-broker shared Omarchy computer and guest-only tools
packages/diagnostics     redacted operational evidence
packages/migration       explicit reviewed data import
packages/release         provenance, artifact verification and safe installation
contracts               machine-readable release and migration requirements
tests/acceptance         cross-package release acceptance
```

```sh
npm ci
npm run check
node scripts/check-legacy-absence.mjs
node scripts/check-release-constitution.mjs
node scripts/run-acceptance.mjs
```

See [the clean architecture](docs/CLEAN_ARCHITECTURE.md) and
[the Release Constitution](contracts/RELEASE_CONSTITUTION.md).

## Build an explicit unsigned development DMG

Build the clean workspace first. Packaging reads only the new desktop output.
It does not modify the source app, install the app, or publish a release.

```sh
npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir --workspace @rapp-work/desktop -- --config.directories.output=dist/package
node scripts/release-macos.mjs \
  --development-unsigned \
  --app "apps/desktop/dist/package/mac-arm64/RAPP Work.app" \
  --output packages/release/dist/artifacts \
  --version 2.0.0
```

The result is visibly named `UNSIGNED-DEVELOPMENT`. Its manifest and sealed
application receipt record that mode; it cannot pass production verification.
Development installation uses **RAPP Work Development.app**, not the production
application name.
Use unsigned development mode only for artifacts you built and trust.

## Verify and install production

A production release consists of a DMG and its `.dmg.provenance.json` sidecar.
Obtain the release public key and Apple Team ID from a separately trusted
publisher source. Never trust a public key merely because it accompanies a
download.

```sh
node scripts/verify-release.mjs \
  --dmg RAPP-Work-2.0.0-macos-arm64.dmg \
  --manifest RAPP-Work-2.0.0-macos-arm64.dmg.provenance.json \
  --trusted-key publisher-public.pem \
  --team-id YOURTEAMID

node scripts/install-macos.mjs \
  --dmg RAPP-Work-2.0.0-macos-arm64.dmg \
  --manifest RAPP-Work-2.0.0-macos-arm64.dmg.provenance.json \
  --trusted-key publisher-public.pem \
  --team-id YOURTEAMID \
  --applications-directory /Applications
```

Use the exact trusted release commit with `--expected-commit` when available.
Quit RAPP Work before replacing it. The chosen applications directory must
already exist, be writable by the installer, and not be symlinked or
world-writable. Installation does not elevate privileges.

Verification checks the signature, complete source and lock inventories,
canonical RAPP/1 identity, arm64 native code, complete packaged-module allowlist,
DMG checksum, sealed app receipt, Developer ID team, hardened runtime,
Gatekeeper assessment, notarization and stapling. Passing metadata or a
successful unit test is not a substitute for these checks on the final binary.

Replacement is staged, verified again, then atomically swapped. The prior app
and a synced installation journal are retained. To restore it, pass the printed
journal path to `scripts/install-macos.mjs --rollback`, with the same applications
directory and independent trust inputs. Recovery never deletes user data,
steals a stale install lock, or guesses after an unexpected filesystem change.

## Data import

Normal startup ignores prior home directories and never loads their executable
attachments. `packages/migration` explicitly inventories selected data and
produces **review-only** plans, rereading source hashes before planning. It does
not automatically apply those plans or delete the original source.

The [migration contract](contracts/migration.schema.json) validates those same
plans before import: agents remain disabled pending policy review, tasks remain
drafts, and memories remain untrusted. It rejects executable destinations,
traversal, unredacted credentials and unknown authority-bearing fields. Applying
a reviewed plan still requires a separately authenticated destination capability,
inert copies under `imports/`, and verified canonical import receipts. Target IDs
in a plan are locators, never ownership grants.

## Production release administration

The protected `production` environment supplies an Apple Developer ID
certificate, notarization credentials, an Ed25519 provenance signing key, and
an independently configured public verification key and Apple Team ID.
`release-macos.yml` accepts only an exact version tag, runs the clean acceptance
gates, signs and notarizes the application and DMG, independently remounts the
artifact, and publishes only verified production files.

Local unsigned builds do not establish production readiness. No production
signature, notarization or live-computer execution is claimed by a fixture test.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
