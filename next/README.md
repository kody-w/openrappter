# RAPP Work — next

An isolated, headless **Autonomous Agent First** replacement. The conversation is
the product. There is no UI, model fallback, automatic native-profile discovery,
shell tool, second Brainstem runtime, or deletion API here.

This directory is deliberately **not** added to the legacy npm workspaces or
release package. The old product remains intact pending the new cutover gates.

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
[root/world](docs/BOT_WORLD_CONTRACT.md).
