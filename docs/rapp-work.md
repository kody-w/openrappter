# RAPP Work

**Your local AI workforce.** Serious local AI for real business work.

Work is the default Lit view in the web dashboard and Electron app, including
the primary tray action. The design uses familiar multi-agent product patterns
without proprietary assets: a persistent roster, explicit active/idle presence,
work threads, a task/run timeline, approval cards, evidence, workspace
boundaries, and a shared local-computer panel.

**RAPP/1 is mandatory for verified Work.** The UI is a derived view, not an
event store. Its exact [RAPP/1 integration contract](./rapp-work-rapp1.md) maps
workspace, task/run, chat, VM, approval, and evidence facts to canonical frames.
Data without scanned-frame evidence stays visibly unverified; Work mutations
are blocked when the canonical gateway adapter is absent.

## Screenshots

- [Desktop · light](./images/rapp-work-desktop.png)
- [Mobile · dark](./images/rapp-work-mobile.png)

These production-build captures show the labeled read-only demo against an
isolated browser fixture gateway. They do not depict real business data,
executed example tasks, or a running VM.

## What is live

- Agents come from `agents.list`; threads and messages come from `chat.list`
  and `chat.messages`. Selecting an agent filters threads by the reported
  `agentId`. Late responses cannot populate a different agent’s thread.
- File and memory paths, isolation, and presence come from workspace RPCs.
  Unknown isolation stays unknown; duplicate paths are flagged as shared.
  These are **gateway-reported indicators**, not a new filesystem sandbox.
- Timeline entries are recorded messages and tool receipts, not inferred
  successful tasks. Supplied citations and tool results are expandable;
  reported sources are not presented as independently verified.
- Approvals read the existing gateway-wide `exec.pending` queue. Decisions
  submit `exec.respond` through **`work.rapp.commit`**, never directly through
  the unframed compatibility method. Missing ownership is labeled rather than
  assigned to the selected agent. An approval does not disappear before a
  hash-checked, request-bound canonical receipt.
  Expired approvals are disabled, and decision controls are excluded from
  autonomous desktop clicking via `data-desktop-sensitive`.
- **Compatibility Chat** opens the existing assistant or selected session.
  Its legacy transport is labeled unverified, not certified as canonical Work
  history or isolated agent dispatch. Specialist components remain functional
  behind an explicit compatibility verification notice.

The shell remains visible during connection attempts and disconnections.
Reconnect restores subscriptions. Work refreshes reported state every 15
seconds and on relevant gateway events; a connected VM status refreshes every
5 seconds. Polling and listeners stop when the view disconnects or unmounts.

## Typed UI contracts

`typescript/ui/src/services/work.ts` is the UI adapter. It calls the existing
gateway transport; this change does **not** implement workspace storage, RAPP
frames, VM commands, or a VM backend.

| Method | Request | Response |
| --- | --- | --- |
| `workspace.list` | none | `{ workspaces: WorkWorkspace[] }` (a bare array is also accepted) |
| `workspace.get` | `{ workspaceId: string }` | `{ workspace: WorkWorkspace }` (a bare workspace is also accepted) |
| `vm.status` | none | `VmStatus` for the local Omarchy computer |
| `vm.start` | through `work.rapp.commit`, with verified predecessor references | frame-backed `VmStatus`; never an optimistic “running” |
| `vm.stop` | through `work.rapp.commit`, with verified predecessor references | frame-backed `VmStatus`; never an optimistic “stopped” |
| `work.rapp.verify` | `WorkProjectionClaim` | canonical scans and frame references; locally hash-checked before a badge is shown |
| `work.rapp.commit` | `WorkCommitRequest` | `WorkCommitResponse` binding an append-only intent and terminal receipt to the exact request |

```ts
interface WorkWorkspace {
  id: string;
  agentId: string;
  name: string;
  rootPath?: string;
  memoryPath?: string;
  isolation: 'dedicated' | 'shared' | 'unknown';
  status: 'active' | 'idle' | 'offline' | 'unknown';
}

interface VmStatus {
  id: string;
  name: string;
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'unavailable' | 'error';
  local: boolean;
  viewerUrl?: string;
  updatedAt?: string;
  message?: string;
  activeAgentId?: string;
}
```

Responses are checked at the boundary. Missing optional presence/isolation
fields become unknown, mismatched workspace IDs or owners are rejected, and
malformed responses remain errors. UI-only `rapp` verification metadata is
attached after checking the frame evidence; a gateway-supplied `verified: true`
or `rapp` field is never trusted.

### Method unavailable is not success

Calls return a discriminated `Capability<T>`: `live`, `unavailable`, or `error`
(plus view-side loading/offline states). Only JSON-RPC `-32601` or an exact
legacy “Method not found: METHOD” / “Unknown method: METHOD” error is considered
method-unavailable. Authentication failures, timeouts, and malformed payloads
do not activate demo data.

When **`workspace.list` is unavailable**, a conspicuous **Local demo · read-only**
banner accompanies realistic example Finance, Operations, and Research work.
Every example has labeled provenance; paths are not created, approvals cannot
be submitted, and example session IDs never enter live Chat. **Use gateway
data** returns to actual agents, sessions, and approvals even on an older
gateway. A missing `workspace.get` only marks the detail panel unavailable.
Empty live lists remain empty.

Missing `work.rapp.verify` does **not** trigger a demo or certify legacy data.
It labels provenance unavailable and disables Work mutations. Missing
`work.rapp.commit` never falls back to `vm.start`, `vm.stop`, or `exec.respond`.
Failures after accepted actions require canonical failure frames, not fabricated
success or an unrecorded state change.

Missing `vm.status` shows an unavailable local-display placeholder, not a
pretend desktop. Missing start/stop methods leave the last reported VM state
unchanged and show an unconfirmed-action message.

## The local-computer boundary

Omarchy is a shared VM on the gateway machine, **not a hosted browser**. Its
shared screen is independent of each agent’s file/memory workspace.

A live iframe is shown only for `state: 'running'`, explicit `local: true`, and
an absolute HTTP(S) viewer URL on `localhost`, `127.0.0.1`, or `[::1]`. External,
credential-bearing, relative, file, and script URLs are rejected. The display
is view-only (`inert`), sandboxed without top-level navigation or same-origin privileges, and
excluded from model-visible desktop snapshots. A viewer must support that
sandbox. A remote gateway does not magically make its loopback viewer local
to the web client; remote display tunneling is outside this UI change.

Start/stop controls require a confirmed local stopped/running state, verified
RAPP/1 evidence, and a deliberate operator click. They send only the guarded
canonical commit RPC; there is no
shell execution, OS integration, VM command implementation, or frame storage
in the renderer.

Local data does not mean all model inference is offline. The configured
provider may be GitHub Copilot or another cloud provider; the UI says so.

## Compatibility and development

Copilot Surgeon, Quantum RAPPIDs, agent management, channels, sessions, skills,
devices, system health, logs, debug, accounts, Showcase, and Zen remain
available through **Compatibility**. Chat, workflow recording, automations,
and settings are primary operational destinations.

The `openrappter` CLI/packages, repository URLs, `openrappter-*` custom elements,
Electron app ID, profile paths, environment variables, and IPC contracts are
retained. The new landing component is `<rapp-work>`.

```bash
cd typescript/ui
npm ci
npm test
npm run build
npm run test:browser
npm run dev
```

Vite serves the UI on port 3000 and proxies gateway traffic to the existing
local gateway on 18790. Theme follows the OS; `?scoutTheme=light` and
`?scoutTheme=dark` are useful for deterministic visual checks.

`test:browser` exercises the **production build** using an installed Chrome
binary (`CHROME_BIN` overrides discovery) and a temporary, isolated profile
inside the project’s ignored `.test-scratch/work-browser/` directory. It uses a
loopback fixture gateway, never the owner’s real gateway, personal browser
profile, or a real VM. Screenshots and `report.json` remain in that directory;
the browser profile and processes are removed when the check completes.

Tests exercise branding/entry points, compatibility navigation, isolation
indicators and stale loads, live versus demo state, VM-local URL restrictions,
canonical approvals, timeline/evidence rendering, event cleanup, and polling.
They also scan the real pinned rev-14 authority frame, verify full fixture
chains with the production scanner, independently recompute hashes, and reject
authority, family, lineage, head, data-binding, and request drift.
