# RAPP Work — next

An isolated, headless **Autonomous Agent First** replacement. The conversation is
the product. There is no UI, model fallback, automatic native-profile discovery,
shell tool, second Brainstem runtime, or deletion API here.

This directory is deliberately **not** added to the legacy npm workspaces or
release package. The old product remains intact pending the new cutover gates.

## Provider-neutral AI-driven projection

The core also exposes an authenticated, provider-neutral publication API:
Copilot, Claude, Hermes, Scout, Grokbot and future AI hosts use one
[portable RAPP Work Bot skill](skills/rapp-work-bot/SKILL.md) with an independently
issued capability for the same root GUID. Public work and closed declarative
view hints are canonical frames, not UI state. Concurrent clients retain
explicit view conflicts; bounded MCP/stdio subscriptions support cursor replay
and resync. No model, renderer, native profile or HTTP listener is started by
publication. Only a tiny test consumer exists.

See [the API/authority contract](docs/AI_PROJECTION_API.md) and
[binding milestones](docs/MILESTONES.md).

## Critical release gate: observed migration

A green API is not release acceptance. `npm --prefix next run migration:gate`
launches the **new** application with an empty isolated fixture profile and a
separate passive real-time display, migrates all selected roots/forms/estate/
native/historical pointers through public API operations, exercises rollback
and restart, checks source zero writes, and produces an offline-tested
self-contained replay. It is mandatory in `npm --prefix next run check`.

See [the exact migration gate](docs/MIGRATION_RELEASE_GATE.md) and
[controlled-local approval/run steps](docs/CONTROLLED_LOCAL_MIGRATION.md).
Live current profiles remain untouched; fixture success cannot qualify a release.

## Catch me up release gate

`npm --prefix next run catch-up:gate` verifies deterministic replay from canonical
frames/cursors: recorded, reconstructed and unavailable presentation grades,
source hashes and exact state digests. The future UI is a passive fast-forward
player; no model/tool execution or mutation occurs during replay.

Optional Omarchy guest replay is explicitly opted-in GODD/private data. Approved
canonical guest PNG frames are recorded; command/diff summaries reconstructed;
missing display unavailable. Host screens, secrets and keystrokes are excluded.
See [Catch me up](docs/CATCH_ME_UP.md). This gate does not replace migration
qualification or live capture/signer/adoption authority.

## Source-owned lifecycle gate

Every new action's exhaust belongs to its original internal scope's canonical
stream. Global Estate, Librarian, collaboration, iMessage recap and Catch-me-up
reference original GUID/scope/frame hashes and branches instead of copying a
central activity log. Causal source-head vectors support independent clocks,
bounded live updates and frames-only rebuild. Historical centralized bytes stay
explicitly historical. `npm --prefix next run source-ownership:gate` is mandatory
in `check`; see [the binding source contract](docs/SOURCE_OWNERSHIP.md).

## Native federation and rooted-estate handoff

The owner `estate.record` API accepts bounded local/native provenance and
separate unresolved/app-only observations, with exact source receipts and
idempotent restart. Recording never registers a workspace automatically.
See [the exporter contract](docs/NATIVE_FEDERATION_API.md).

The [frozen rooted-estate handoff](docs/ROOTED_ESTATE_HANDOFF.md) is reference
evidence only. Full body-stream RAPPIDs remain identity; closure, domain,
code-loading and shared-runtime adoption flags remain false until real bindings.

## Private continuity acceptance

`npm --prefix next run imessage:gate` proves pure CLI/gauntlet reporting,
source-reference question queueing, external non-CLI pending input and separate
approval-gated synthetic delivery. Private transport material stays in a strict
same-user runtime sibling, never canonical data or Egg. Cancellation,
preflight generations, batch deferral, quiet/rate bounds and restart recap are
canonical; no uncertain send is replayed. Live TCC/contact setup stays disabled.
See [the channel contract](docs/CHANNEL_CONTRACT.md).

## Unattended recurring work

Reviewed `canonical-recap` routines can run without a caller issuing
`work.due`/`work.tick`. An owner launches the separate scheduler with an exact
root allowlist:

```sh
npm --prefix next run build
node next/dist/scheduler-cli.js --store next/.state \
  --root "<full canonical RAPPID>"
```

The process performs an immediate restart catch-up scan, then polls. Bounded
same-user lease records live only in `<store>.scheduler/`; canonical routines,
occurrence claims and outcomes remain in the original source-owned RAPP/1
streams. Hidden or forked roots are fenced, concurrent processes converge on
the same deterministic occurrence receipt, and no model, provider, delivery or
external approval is invoked. Signed roots require signer custody injected by
the trusted owner host; the packaged process does not discover live credentials.
Use `--once` for an owner-managed timer/service invocation.

## Development

Node 22.12+; pinned development dependencies and Copilot SDK are declared in this
directory. The only adopted product code is the standalone RAPP/1 **wire
primitive** package, consumed through `src/canonical.ts`. No application, domain,
service, store, UI, or provider package is imported.

```sh
npm --prefix next run browser:install
npm --prefix next run typecheck
npm --prefix next test
npm --prefix next run gates
```

Run the CLI/stdio boundary:

```sh
node next/dist/cli.js --store next/.state --id create-my-bot bots.create '{"name":"My Work"}'
node next/dist/cli.js --store next/.state stdio
node next/dist/scheduler-cli.js --store next/.state --root "<full canonical RAPPID>"
```

This creates a canonical local root, not a live model session. Real provider,
Brainstem, Hive, domain-transfer and iMessage bindings remain explicit gates.
For the complete **synthetic** dogfood scenario:

```sh
node next/scripts/e2e.mjs
```

It exercises two signed root bots, thought/review/confirmation, Copilot Builder,
RAPP Up native pointers, weekly work, correction, branch preservation, public
collaboration, an iMessage outage/recap/retry, external-action refusal and restart
without replay. It writes inspectable canonical evidence below
`next/.test-scratch/`, not a live profile.

Local validation may reuse already-installed exact-version dependencies. CI
performs clean installs from both committed lockfiles and installs the
Playwright-pinned Chromium revision before running the complete check. Neither
path launches a model or touches a live profile.

The canonical rev-15 checker is vendored byte-for-byte at
`kody-w/rapp-1@dda32d741c7218f41443a5bd17eebfe0eae82cb7`. The foundation gate requires
actual emitted frames and a nonzero `COMPLIANT` result, not an empty `CLEAN` scan.

The legacy whole-repository source gate continues to ban Python generally. Its
only greenfield exception is the closed list of exact paths and SHA-256 hashes in
`contracts/legacy-allowlist.json`, used for the target-owned contract and
independent canonical verifiers. That exception is source-only; packaged Python
remains forbidden and the artifact allowlist is unchanged. `next/` is therefore
still not release-qualified by the old pipeline. See the historical
[foundation verification receipt](verification/foundation.json).

Binding contracts: [architecture](docs/ARCHITECTURE.md),
[primitive mapping](docs/RAPP1_MAPPING.md),
[root/world](docs/BOT_WORLD_CONTRACT.md),
[interaction/CLI](docs/INTERACTION_CONTRACT.md),
[private channel](docs/CHANNEL_CONTRACT.md),
[passive projection](docs/PROJECTION_CONTRACT.md),
[migration/cutover](docs/MIGRATION_CUTOVER.md), and
[discarded patterns](docs/DISCARDED_PATTERNS.md).

See [exact verification and blockers](docs/VERIFICATION.md) and
[prototype evidence usage](docs/SOURCE_EVIDENCE.md). This milestone does not
authorize production cutover or removal of the retained implementation.
