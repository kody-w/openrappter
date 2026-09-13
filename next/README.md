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

## Development

Node 22.12+; pinned development dependencies and Copilot SDK are declared in this
directory. The only adopted product code is the standalone RAPP/1 **wire
primitive** package, consumed through `src/canonical.ts`. No application, domain,
service, store, UI, or provider package is imported.

```sh
npm --prefix next run typecheck
npm --prefix next test
npm --prefix next run gates
```

Run the CLI/stdio boundary:

```sh
node next/dist/cli.js --store next/.state --id create-my-bot bots.create '{"name":"My Work"}'
node next/dist/cli.js --store next/.state stdio
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

Validation for this milestone reuses already-installed, exact-version
dependencies through an ignored worktree-local `node_modules` link. It does not
install dependencies, launch a model, or touch a live profile.

The canonical rev-15 checker is vendored byte-for-byte at
`kody-w/rapp-1@dda32d741c7218f41443a5bd17eebfe0eae82cb7`. The foundation gate requires
actual emitted frames and a nonzero `COMPLIANT` result, not an empty `CLEAN` scan.

The legacy whole-repository source gate bans **all Python** and consequently
rejects the isolated target-owned `agent.py` contract and canonical reference
checker. That legacy gate is not weakened. The old artifact allowlist remains
unchanged; `next/` is not release-qualified by the old pipeline. See the honest
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
