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
| `storage` | Canonical store initialization, owner-catalog reads, health |
| `security` | Bearer authentication, principal/workspace identity, per-action authorization |
| `work` | Roster, tasks, runs, approvals, artifact content, schedules, typed settings |
| `runtime` | Actual execution, cancellation, approval delivery, schedule reconciliation |
| `provider` | Configured model inventory and secure connection references |
| `computer` | Actual computer state, capabilities, lifecycle, verification evidence |
| `diagnostics` | Bounded reports and payload-free failure records |

Types are exported from `src/ports.ts`; runtime wire schemas are in
`src/contracts.ts`. Missing ports or methods fail startup. Each port must report
its own readiness. The host never turns a missing adapter into a success.

`createLocalServices` binds the workspace store, RAPP/1 scanner, security
authority, work service, agent runtime, Copilot SDK and computer broker. A
private `owner.json` mints one local owner; one `workspaces/` store contains
the owner catalog, separate computer history, and independently minted agent
workspaces. The catalog only locates per-agent state. Tasks, runs, approvals,
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

## Transport contract

The listener is always `127.0.0.1` (an ephemeral port by default). It validates
the peer, exact numeric loopback Host header, and explicit Origin allowlist.
No wildcard or opaque origins are accepted.

* `POST /rpc`: one JSON-RPC 2.0 request, with `id`, `method`, and object `params`.
* `GET /rpc` with a WebSocket upgrade: the same request/response protocol.
* `GET /healthz`: authenticated process liveness.
* `GET /readyz`: authenticated aggregate service health; HTTP 503 unless **all**
  required services report ready.

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
| Work | `work.snapshot`, `work.createTask`, `work.assignTask`, `runs.start`, `runs.cancel`, `approvals.decide`, `artifacts.read` |
| Agents | `agents.save` |
| Automations | `automations.save` |
| Settings/services | `settings.update`, `providers.list`, `providers.configure`, `computer.inspect`, `computer.start`, `computer.stop`, `system.status`, `diagnostics.get` |
| Events | `events.read`, `events.subscribe`, `events.unsubscribe` |

The aggregate snapshot requires all four area read grants. Its `ownerId` and
`workspaceId` identify the owner and catalog; every agent, assigned task, run,
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

Tests bind real HTTP/WebSocket loopback sockets with injected services and cover
authentication, origin/rebinding protection, strict schemas, authorization,
readiness, replay scope/retention/revocation, subscriptions, storage persistence,
business invariants and unavailable services. Production integration tests use
real filesystem persistence with fake Copilot/Tart/SSH transports, including
two-agent isolation, approval consumption, read-only execution, cancellation,
scheduled execution, restart, uncertain outcomes and UI DTO alignment.
`npm run test:bundle` additionally boots the actual bundled host twice and scans
its persisted frames. Test profiles are app-local and removed.
