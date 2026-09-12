# RAPP Work host

An application host with structural service ports, not a second agent runtime.
There are no imports from other workspace packages or older applications.

## Build and validate

From `apps/host`:

```sh
npm ci --workspaces=false
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
| `storage` | Initialization, scoped reads, serialized durable transactions, health |
| `security` | Bearer authentication, principal/workspace identity, per-action authorization |
| `work` | Roster, tasks, runs, approvals, artifact content, schedules, typed settings |
| `runtime` | Actual execution, cancellation, approval delivery, schedule reconciliation |
| `provider` | Configured model inventory and secure connection references |
| `computer` | Actual computer state, capabilities, lifecycle, verification evidence |
| `diagnostics` | Bounded reports and payload-free failure records |

Types are exported from `src/ports.ts`; runtime wire schemas are in
`src/contracts.ts`. Missing ports or methods fail startup. Each port must report
its own readiness. The host never turns a missing adapter into a success.

`createLocalServices` is the desktop's initial composition. It persists real
workspace records in private, versioned JSON files using atomic replacement and
file/directory synchronization. Reads fail closed on corruption, linked files,
wrong workspace IDs, or non-private permissions. Transactions are serialized
within the single owning host process; the directory is not a multi-process
database.

**The initial composition has no execution runtime, scheduling engine, provider,
computer, or artifact-content adapter.** These services explicitly report
unavailable. Agents, queued tasks, disabled schedules, and settings can be saved.
There is no seeded product data. Runtime adapters must own durable execution,
idempotency/reconciliation, approval enforcement, and real evidence production;
an RPC acknowledgment is not an exactly-once execution guarantee.

The stricter workspace/agent approval policy is passed to execution. Computer
work requires a service-reported running computer with the relevant capabilities.
Changing active agent configuration, double-starting a task, reassigning active
tasks, stale approvals, and unconfirmed schedule activation are rejected.

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

The aggregate snapshot requires all four area read grants. Workspace identity
comes exclusively from the authenticated principal, never request parameters.
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

An integrated service persists its actual state through its work/storage ports,
then calls `host.publish(workspaceId, event)`. Nothing in the renderer manufactures
run completion or computer verification.

## Test coverage

Tests bind real HTTP/WebSocket loopback sockets with injected services and cover
authentication, origin/rebinding protection, strict schemas, authorization,
readiness, replay scope/retention/revocation, subscriptions, storage persistence,
business invariants, and unavailable services. Storage test data stays inside
the app's ignored `.test-scratch/` directory and is cleaned after each test.
