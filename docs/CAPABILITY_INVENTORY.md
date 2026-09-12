# RAPP Work Capability Inventory

This document is the binding product inventory for the clean rewrite. Existing
code is not retained because it exists or has tests. A capability survives only
when it directly supports serious business work in the product described here.

## Product definition

RAPP Work is one macOS Apple Silicon desktop application for persistent business
agents. Every agent owns one independent local RAPP/1 workspace. All agents use
one application-owned Omarchy VM as their computer. Durable work, approvals,
tool calls, VM transitions, artifacts, and evidence are represented by canonical
RAPP/1 frames.

RAPP Work is not an agent framework, messaging hub, social network, creature
simulator, demo catalogue, telephony platform, game, second-brain client, or
multi-runtime compatibility distribution.

## Decision vocabulary

- **KEEP**: retain the capability and its core invariants.
- **REDESIGN**: retain the user outcome behind a new bounded interface.
- **MIGRATION-ONLY**: import data explicitly; never load or execute legacy code.
- **REMOVE**: absent from source, package, application, documentation, and CI.

## Capability ledger

| Capability | Decision | New role in RAPP Work |
|---|---|---|
| Persistent agent roster | REDESIGN | Create, configure, pause, resume, and retire business agents. Each agent is bound to one workspace and an explicit tool policy. |
| Per-agent local workspace | KEEP | Sole local owner of agent identity, artifacts, tasks, memory, and body/memory/swarm RAPP/1 streams. |
| RAPP/1 authority, canonical JSON, frames, evidence, chain verification | KEEP | Integrity foundation for every durable business transition. Preserve accepted wire identifiers and rev-14 authority exactly. |
| Work projections and commits | REDESIGN | Read state only from scanned committed frames. Mutations require current trusted heads, write-ahead intent, execution, terminal receipt, linked evidence, and read-back verification. |
| Business work threads | REDESIGN | Agent-scoped conversations and tasks in one Work surface. No separate Chat or Sessions products. |
| Tasks and runs | REDESIGN | Durable state machines rebuilt from RAPP/1 frames; checkpointed steps, cancellation, bounded retries, and unresolved crash outcomes. |
| Approvals | KEEP | Agent/task-scoped decisions bound to the exact operation, resources, expiry, and single-use canonical receipt. |
| Evidence and citations | KEEP | Explainable support attached to tasks, artifacts, and decisions. Integrity is never presented as factual truth or authorship. |
| Model provider | REDESIGN | One host-owned provider interface, initially GitHub Copilot. Provider choice never changes tool permissions or workspace scope. |
| Business tools | REDESIGN | Small permissioned catalogue: guest shell, files, Git, browser, research, document/artifact operations. Every effect runs through a scoped permit. |
| Workflow orchestration | REDESIGN | One durable workflow engine. Remove chain/graph/broadcast/router/subagent frameworks as separate public concepts. |
| Shared Omarchy VM | KEEP | One persistent application-owned Tart VM. Agents execute only inside the guest with workspace capabilities; no host-shell fallback. |
| VM provisioning and display | REDESIGN | Pinned image, checksum, host key, lifecycle lease, local display, mediated artifact transfer, explicit unavailable state. |
| Authentication | REDESIGN | One Settings surface for the active provider and local host principal. Authentication is distinct from agent authorization. |
| Configuration | REDESIGN | Typed settings for provider, storage, VM, permissions, retention, and diagnostics. No raw general-purpose config editor. |
| Scheduling | REDESIGN | Agent-owned business schedules represented by canonical frames. No generic presets or channel delivery. |
| Diagnostics / flight recorder | KEEP | Redacted support traces and usage diagnostics only. Never a competing task or approval authority. |
| Desktop shell | REDESIGN | One Electron macOS arm64 app with an isolated renderer, narrow preload, owned host lifecycle, and integrated tray. |
| Release provenance and installer | KEEP/REDESIGN | Signed/notarized production artifact, complete source/lock/artifact provenance, mandatory verification, safe atomic replacement. Unsigned local builds remain explicit development artifacts. |
| Existing user data | MIGRATION-ONLY | Read inert legacy data, copy selected records into new workspaces through canonical import frames, archive originals, never execute imported code. |
| Existing Python agents and cartridges | MIGRATION-ONLY | Preserve source as disabled attachments and offer explicit porting. No Python runtime discovery or execution in the product host. |
| Existing chat/session/memory JSON | MIGRATION-ONLY | Import into agent workspaces as dated historical records with provenance. |
| Existing skills | MIGRATION-ONLY | Import reviewed procedures as disabled drafts. No marketplace or automatic enablement. |
| License and attribution notices | KEEP | Preserve required notices for any retained implementation. |

## Removed product capabilities

The following are removed rather than hidden behind compatibility navigation:

- Copilot Surgeon, patient/case/procedure metaphors, and runtime self-surgery
- Quantum RAPPIDs, creature identity, growth, music, organism, and iOS companion
- Show-and-Tell recording, DemoRecorder, narration, Whisper, VibeVoice, and TTS
- Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Google Chat, Teams,
  Matrix, channel configuration, and messaging ownership
- telephony, Twilio, Retell, Google Voice, hotline, SMS, callbacks, and `rsb`
- personal twins, neighbors, eggs, peer `/twin` messaging, and social sync
- Showcase tournaments, evolution, cloning, power prompts, and demo runners
- Zen, Pong, Dojo, terminal entertainment, breathing, and experimental tabs
- arbitrary production RPC console and generic filesystem agent editor
- ClawHub, RappterHub, OpenClaw compatibility, and public skill marketplaces
- Python runtime, NanoRappter, dual-runtime parity, PyPI release, and Python CLI
- Docker/Compose deployment, Windows installer, Linux AppImage, iOS app, Swift
  menu bar app, and separate native release channels
- broad shell installers, source-clone installation, global npm installation,
  repair scripts, release rings, and the previous release-train workflows
- Obsidian vault, Fable assets, historical ORDER/PLAN files, framework examples,
  synthetic production demo data, and legacy product documentation

## Product navigation

1. **Work** — agent roster, work threads, tasks/runs, evidence, and shared computer.
2. **Agents** — create/configure agents, assign tools, inspect workspace health.
3. **Automations** — schedules and recurring work owned by an agent.
4. **Settings** — provider, VM, permissions, storage, retention, diagnostics, migration.

There is no Compatibility section.

## Retention tests

The clean rewrite is not accepted unless:

- the shipped ASAR and source dependency graph contain no legacy runtime,
  Python runtime, channel, telephony, surgeon, RAPPID, showcase, zen, twin, or
  show-and-tell modules;
- legacy directories populated with sentinel credentials and executable agents
  are not read during normal startup;
- two agents cannot read or mutate each other's workspaces;
- tasks, approvals, runs, and VM state rebuild from frames alone;
- missing VM or persistence produces zero tool execution;
- the packaged app contains only the new host, UI, protocol, workspace, security,
  diagnostics, migration, provider, and computer-broker modules.
