# RAPP Work Clean Architecture

## Repository

```text
apps/
  desktop/              Electron main, preload, tray, packaging
  host/                 composition root and authenticated local RPC
  ui/                   Work, Agents, Automations, Settings
packages/
  rapp1/                authority, canonical JSON, frames, evidence, scanning
  workspace-store/      agent identity, private files, locks, streams, batch CAS
  domain/               agents, tasks, runs, approvals, artifacts, reducers
  work-service/         projections, proofs, command commit orchestration
  agent-runtime/        persistent workers and provider/tool execution loop
  model-provider/       GitHub Copilot provider contract and implementation
  security/             principals, capabilities, permits, approval consumption
  computer-broker/      Tart lifecycle, guest execution, display, transfer
  diagnostics/          redacted traces, health, support export
  migration/            inert legacy readers and canonical import
  release/              artifact provenance, verification, installer
contracts/
fixtures/rapp1/
tests/
  unit/
  integration/
  acceptance/
  macos-arm64/
scripts/
docs/
```

## Dependency direction

```text
rapp1
  ↓
workspace-store   security   domain
  ↓                  ↓         ↓
work-service   agent-runtime  computer-broker
          \        |        /
             apps/host
                 ↓
              apps/ui
                 ↓
            apps/desktop
```

Protocol code imports no application, provider, agent, gateway, or VM code.
Applications receive mandatory dependencies at the composition root. There are
no optional production adapters whose absence leaves a branded but non-working
surface.

## Ownership

- A **Principal** is the authenticated local human or trusted host component.
- An **Agent** is a persistent worker definition and policy.
- An **AgentWorkspace** is the agent's sole durable state owner.
- A **Task** belongs to one agent and one workspace.
- A **Run** is one execution attempt for a task.
- The **Computer** is one shared host-owned Omarchy VM with its own canonical
  body history. Agent tool streams reference computer receipts.

Caller-supplied IDs locate resources; they never grant authority. Every service
receives a scoped capability created after authorization.

## Canonical transition

1. Resolve principal, agent, workspace, task, and current trusted heads.
2. Authorize the exact command and affected resources.
3. Append and read back one canonical write-ahead intent.
4. Execute once inside the Omarchy guest under a scoped permit.
5. Append terminal outcome and linked evidence.
6. Read back and scan the committed chains.
7. Publish the projection/event only after verification.

If outcome persistence is uncertain, the run becomes `unresolved`; it is never
automatically replayed.

## Host boundary

The host may execute only fixed application-owned commands needed to manage
Tart and its SSH transport. Agent tools cannot invoke host shell commands. All
business execution happens in the guest. The guest receives mediated workspace
access rather than arbitrary host mounts.

## Storage

Each agent workspace contains:

```text
identity.json
manifest.json
frames/body/
frames/memory/
frames/swarm/
artifacts/
imports/
```

Tasks, approvals, schedules, runs, and memories are projections from frames.
SQLite may index projections and diagnostics, but is never the canonical event
authority.

## Migration

Migration is a separate executable mode:

1. discover known legacy paths without loading code;
2. inventory records and produce a review plan;
3. copy selected data to `imports/`;
4. append canonical import frames with source hashes and timestamps;
5. verify the new workspace;
6. archive but do not delete the source automatically.

Normal startup does not probe legacy homes.

## Release boundary

Production supports macOS Apple Silicon only. The release gate verifies:

- exact clean source commit and lockfiles;
- complete packaged module allowlist;
- absence of removed legacy modules and assets;
- RAPP/1 authority and fixture hashes;
- signed application, hardened runtime, notarization, and stapling;
- DMG checksum and provenance;
- safe replacement and rollback.

Unsigned local builds are clearly marked development builds and are never
published as production.
