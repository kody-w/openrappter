# RAPP Work host

The production composition of the clean public packages, not a second protocol
implementation or an application loader.

## Build and validate

From `apps/host`:

```sh
npm ci --prefix ../..
npm run typecheck
npm test
npm run build
```

The build produces the typed library in `dist/` and a self-contained Node bundle,
`dist/host.cjs`, for the desktop's owned utility process.

## Mandatory composition

`createHost(services, options)` requires every member of `HostServices`:

| Port | Responsibility |
| --- | --- |
| `storage` | Canonical store initialization, business-catalog reads, health |
| `security` | Bearer authentication, principal/workspace identity, per-action authorization |
| `work` | Roster, tasks, runs, approvals, artifact content, schedules, typed settings |
| `runtime` | Actual execution, cancellation, approval delivery, schedule reconciliation |
| `provider` | Configured model inventory and secure connection references |
| `computer` | Actual computer state, capabilities, lifecycle, verification evidence |
| `diagnostics` | Bounded reports and payload-free failure records |
| `twin` | Strict conversational drafting, canonical turns/proposals, reviewed Work API application |

Types are exported from `src/ports.ts`; runtime wire schemas are in
`src/contracts.ts`. Missing ports or methods fail startup. Each port must report
its own readiness. The host never turns a missing adapter into a success.

`createLocalServices` binds the workspace store, RAPP/1 scanner, security
authority, work service, agent runtime, Copilot SDK and computer broker. A
private `owner.json` mints one local owner; one `workspaces/` store contains
the owner concierge/catalog, one catalog/Twin scope per business, separate
computer history, and independently minted child agent workspaces. Each
catalog only locates its own children; verified parent ownership is required
before capability issuance. Tasks, runs, approvals,
settings, schedules and artifact registrations are rebuilt from scanned frames,
not JSON snapshot files. A process-owned filesystem lock excludes another host
from the same application data directory.

All effects follow durable intent → scoped permit → acknowledged outcome →
linked evidence → scanned read-back. Approval requests and decisions additionally
use security's occurrence-bound memory/body evidence pairs. Approval consumption
is durable and single-use. Model execution is asynchronous; RPC returns after a
canonical run acceptance, and committed invalidations refresh the UI as work
progresses. Uncertain work is explicitly `unresolved`, never automatically
resumed. Known cancellation is terminal only after effects acknowledge it.

Saved definitions feed a separate bounded runtime context for each run in its
agent's own workspace. Results and evidence files use workspace artifact
capabilities, immutable writes, SHA-256 and byte read-back. Persisted daily,
weekly and interval schedules execute once while the app is open; missed
offline occurrences are skipped. Failed/unconfirmed scheduling is paused.
There is no seeded product state or executable attachment discovery.

See [local production setup](../../docs/LOCAL_PRODUCTION.md) for Copilot login,
the pinned local Omarchy template and guest helper. Missing authentication,
Tart, image, SSH identity or persistence is explicit and never a fallback.

The stricter workspace/agent approval policy is passed to execution. Computer
work requires a service-reported running computer with the relevant capabilities.
Changing an active/unresolved agent's configuration, double-starting a task,
changing task ownership after a run, stale approvals and unconfirmed schedule
activation are rejected.
The production storage port has no snapshot-mutation hook. All writes go through
the canonical work service; `ProjectionStoragePort` is reserved for explicit
injected record-store compositions and test fixtures.

## Conversation first

Humans speak or type intent. The Twin generates and fills out structured work;
it never presents a blank form as the normal workflow. It asks only necessary
follow-ups, returns a complete reviewable draft, and accepts small human edits
or dismissal. The low-level Work APIs remain explicit reviewed-edit APIs, not
a requirement for humans to fill fields themselves.

`twin.message` uses this shared wire request:

```ts
type TwinMessageRequest = {
  workspaceId: string | null; // null is the owner concierge, never implicit
  message: string;
  target?: "auto" | "workspace" | "task" | "agent" | "automation" | "settings" | "approval";
  history: { role: "user" | "assistant"; content: string }[];
  contextRevision?: number;
};
```

For example, start with `{ workspaceId: null, message: "Set up my consulting
business with an operations lead and a weekly review", history: [],
target: "workspace" }`. No form values or fabricated provider defaults are
needed from the human.

The result is the shared `TwinDraft`:

```ts
type TwinDraft = {
  id: string;
  workspaceId: string | null;
  kind: "workspace" | "task" | "agent" | "automation" | "settings" | "approval" | "clarification";
  assistantMessage: string;
  summary: string;
  confidence: number;
  readyForReview: boolean;
  missing: string[];
  draft: object | null;
  basis: object | null;
  createdAt: string;
};
```

The exported runtime schema is stricter than this integration sketch: ready
proposals have the complete kind-specific draft and no missing fields;
clarifications have `readyForReview: false`, nonempty `missing`, and
`draft: null`. Workspace drafts include name, purpose, Twin identity and
instructions, a complete lead agent, nullable starter task, up to eight starter
routines, and explicit approval/computer policies. Settings drafts are
nonempty, strictly validated patches.

Only verified, authorized context options and server-allocated new identifiers
can appear in availability/ownership-dependent fields. Global context contains
business summaries, not other businesses' conversations or task contents.
Business context contains only that business's agents, work and approvals.
Supplied history is untrusted conversation data, never authority, and is not
re-persisted as if the supplied assistant turns were canonical.

Limits: 24 supplied history entries, 8,000 characters per message/turn, and
48 KiB per serialized message request. Provider prompts/schemas and responses
have separate bounds. Snapshot conversations return the latest 500 turns,
250 proposals and 500 lifecycle events; older canonical history remains
durable. A stale `contextRevision` rejects the message before recording a turn.

User turns are committed before drafting. Assistant turns and proposals share
a verified model-command outcome/evidence triple. Invalid output/unavailability
persists an error event, not a fake assistant response. Uncertain model
intents are never replayed after restart.

### Accept, edit, dismiss

Send `twin.applyProposal` with `{ workspaceId, id, proposalHash }`, where
`proposalHash` is `draft.basis.proposalHash`. Optional `editedDraft` supplies
the complete revised kind-specific object, not a metadata/authority override.
Review edits cannot change a proposal's resource identity.
The host loads the canonical proposal, verifies its hash, owner, current
catalog/child heads and current option inventory, reauthorizes the target
action, and calls the same `createWorkspace`, `createTask`, `saveAgent`,
`saveAutomation` or `updateSettings` Work API as reviewed manual edits.
Retries return the original committed acceptance; changed retries conflict.

An interleaved catalog write during model generation also invalidates a
proposal, even if provider/computer availability later looks unchanged.
There is no automatic task start, guest execution, approval decision, or
computer provisioning in this path. An enabled routine is an explicitly
reviewed schedule and still obeys the normal runtime/approval policy.

Approval drafts are recommendations only: applying one is rejected. The human
must explicitly call `approvals.decide` with the exact approval ID, decision
and reason; existing scope, expiry, active-run and consumption checks apply.
`twin.dismissProposal` takes `{ workspaceId, id, proposalHash, reason? }`.
Accepted or unresolved applications cannot be dismissed as unapplied.

Workspace creation commits and scans all bootstrap state before publishing
one owner-catalog entry linking the business bootstrap evidence. This gives
atomic visibility, not a cross-directory transaction claim. Failed/uncertain
creation leaves staged scopes inaccessible, returns unresolved, and cannot
be automatically reminted. Complete published businesses and conversations
are reconstructed after restart from frames, not a selected-workspace cache.

## Transport contract

The listener is always `127.0.0.1` (an ephemeral port by default). It validates
the peer, exact numeric loopback Host header, and explicit Origin allowlist.
No wildcard or opaque origins are accepted.

* `POST /rpc`: one JSON-RPC 2.0 request, with `id`, `method`, and object `params`.
* `GET /rpc` with a WebSocket upgrade: the same request/response protocol.
* `GET /healthz`: authenticated process liveness.
* `GET /readyz`: authenticated aggregate service health; HTTP 503 unless **all**
  required services report ready. The provider check also includes Twin
  readiness for the required Astra max profile.

All operational requests and upgrades require `Authorization: Bearer …`.
Explicit-origin CORS preflight is the sole unauthenticated transport response
other than rejections. Tokens are never accepted through a URL, cookie, or
WebSocket subprotocol. The desktop sends its ephemeral 384-bit token through
private parent/child IPC, never to the renderer or on a process command line.

Unknown fields, unknown methods, batches, binary WebSocket frames, and
notification-style commands without an ID are rejected. Inputs are capped at
64 KiB; service results at 32 MiB, consistent with the local store capacity.
WebSocket buffering is bounded at 34 MiB, requests at 32 per connection, and
subscriptions at 16. HTTP headers/body reads, service health checks, socket
heartbeats, and transport shutdown are bounded. Internal exception details are
not returned or recorded.

### Methods

| Area | Methods |
| --- | --- |
| Business catalog | `workspaces.list`, `workspaces.create`, `workspaces.update`, `workspaces.open` |
| Twin | `twin.message`, `twin.conversation`, `twin.applyProposal`, `twin.dismissProposal` |
| Work | `work.snapshot`, `work.createTask`, `work.assignTask`, `runs.start`, `runs.cancel`, `approvals.decide`, `artifacts.read` |
| Agents | `agents.save` |
| Automations | `automations.save` |
| Settings/services | `settings.update`, `providers.list`, `providers.configure`, `computer.inspect`, `computer.start`, `computer.stop`, `system.status`, `diagnostics.get` |
| Events | `events.read`, `events.subscribe`, `events.unsubscribe` |

Every normal Work, agent, run, approval, artifact, automation, settings,
computer-control and event RPC requires `workspaceId` alongside its other
parameters. For example, `work.snapshot` takes `{ workspaceId }`, and
`work.createTask` takes `{ workspaceId, ...TaskInput }`. Omission is invalid;
the owner catalog or an agent-workspace ID cannot substitute for a business
binding. Authorization checks the principal and the business separately.
There is no process-global selected workspace.

`workspaces.list` takes `{}` and returns `{ ownerId, conciergeWorkspaceId,
workspaces: WorkspaceSummary[] }`. `workspaces.create` takes the complete
strict `WorkspaceInput` in the owner concierge. `workspaces.update` takes
`{ workspaceId, ...WorkspaceDetails }`. `workspaces.open` takes
`{ workspaceId }` and returns `{ workspace, snapshot, twin, routines, computer }`
for the selected business. `twin.conversation`, `providers.list`,
`computer.inspect` and `diagnostics.get` allow an **explicit** null binding for
concierge context; normal Work mutations do not.

The aggregate snapshot requires all four area read grants. Its `ownerId` and
`workspaceId` identify the owner and selected business catalog; every agent, assigned task, run,
approval, artifact and automation carries its actual agent workspace ID.
An unassigned draft has a null agent/workspace pair. The UI imports the same
pure DTO schemas rather than maintaining a second set.
Artifact content must match its declared byte size and SHA-256 digest.
Verification claims require service-reported evidence references.

### Scoped events

Event scopes are `{ area, entityId? }`. Opaque HMAC cursors are bound to the
principal, workspace, full scope, and host instance. Cross-scope, modified,
future, and expired cursors are rejected explicitly. The default journal retains
512 invalidations per workspace. Cursor expiry or host restart requires a fresh
snapshot and subscription without the old cursor.

`events.subscribe` returns `{ subscriptionId, events, cursor }`, followed by
JSON-RPC `events.changed` notifications containing the same three fields.
Truncated initial replay is drained without waiting for a new event. Permission
and token validity are checked again on delivery. Unsubscribe/disconnect removes
listeners. Events are invalidations, not durable audit evidence.

Production work subscriptions publish only after canonical commit verification.
`host.publish` remains available for explicitly injected compositions. Nothing
in the renderer manufactures run completion or computer verification.

## Test coverage

 with injected services and cover
authentication, origin/rebinding protection, strict schemas, authorization,
readiness, replay scope/retention/revocation, subscriptions, storage persistence,
business invariants and unavailable services. Production integration tests use
real filesystem persistence with fake Copilot/Tart/SSH transports, including
two-agent isolation, approval consumption, read-only execution, cancellation,
scheduled execution, restart, uncertain outcomes and shared DTO alignment.
Twin coverage includes business isolation, all proposal kinds, clarifications,
review edits, canonical conversation scans, partial-bootstrap publication
failure, hash/head/inventory staleness, concurrent accepts, missing bindings,
provider failure, strict exact-option validation, and recommendations that
cannot consume approvals.
`npm run test:bundle` additionally boots the actual bundled host twice and scans
its persisted frames. Test profiles are app-local and removed.
