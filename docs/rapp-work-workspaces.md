# RAPP Work: private agent workspaces

RAPP Work gives each agent its own durable identity, files, tasks, and three
independent RAPP/1 frame streams. Nothing is stored in the legacy shared
`workspace/` or the executable agent-source directory.

The default parent is `~/.openrappter/workspaces/`. `OPENRAPPTER_HOME` relocates
that parent to `<OPENRAPPTER_HOME>/workspaces/`; a gateway configured with
`dataDir` uses `<dataDir>/workspaces/`. Existing CLI names, environment variables,
and canonical protocol schema names remain unchanged for compatibility.

## Layout and identity

```text
workspaces/
  .locks/                         per-agent cross-process writer locks
  research-agent/
    identity.json                 private mint-once tail; never returned by RPC
    manifest.json                 public identity, selected authority, committed frame index
    files/                        this agent's working files
    tasks/                        this agent's task artifacts
    streams/
      body/                       canonical evidence body.pulse frames
      memory/                     accepted memory kinds
      swarm/                      accepted, signature-verified swarm kinds
        0000000000000000-<frame_hash>.json
```

Each frame file contains exactly one canonical RAPP/1 frame, not an application
envelope masquerading as a frame. Stream IDs are independent:

- **Body:** `rappid:@rapp-work/<agent-id>:<public-rappid-hex>`
- **Memory:** `<body-stream-id>:memory`
- **Swarm:** `net:<public-rappid-hex>`

Every newly published workspace already has a body genesis frame:
`kind: "body.pulse"`, canonical `openrappter-evidence/1` payload,
`event_kind: "workspace.created"`, `subject: <workspace RAPPID>`, and the
selected protocol authority. Its UTC is the identity's creation time.
Its `data_hash` is the canonical particle-domain hash of:

```text
{
  identity: { agentId, rappid, createdAt },
  protocolRevision: { revision, frame_hash, payload_hash },
  streams: { body: <stream ID>, memory: <stream ID>, swarm: <stream ID> }
}
```

This public descriptor excludes the private tail and relocatable filesystem
paths. The identity file stores secret material and the manifest is a storage
index/checkpoint, **not a second event or workspace-history format**. Creation
is represented by the frame, and every subsequent committed index change
corresponds to an appended canonical frame in its own stream family.

Agent IDs must be lowercase alphanumeric labels with single interior hyphens,
at most 64 characters. Windows device names are reserved on every platform.
IDs are rejected, never trimmed, decoded, lowercased, or otherwise normalized.
This prevents filesystem aliases from merging identities.

Workspace-owned directories are created with mode `0700`, and control/frame
files with `0600`, on platforms supporting POSIX permissions. Existing unsafe
permissions, symlinks (including ancestors), hard-linked control/frame files,
and special files are refused rather than repaired. On Windows these modes
do not establish an ACL; protect the data directory with the host's ACL policy.

## TypeScript API

The API is exported from `openrappter/dist/workspaces/index.js` and the agent
barrel. An explicit `rootDir` must be absolute and contain no traversal.

```typescript
import { createHash } from 'node:crypto';
import { WorkspaceStore, commitWorkspaceEvidence } from 'openrappter/dist/workspaces/index.js';

const workspaces = new WorkspaceStore();
const workspace = await workspaces.ensure('research-agent');
const frame = await commitWorkspaceEvidence(workspaces, 'research-agent', {
  eventKind: 'task.completed',
  subject: 'task:research-42',
  dataHash: createHash('sha256').update('completed research artifact').digest('hex'),
});
const scan = await workspaces.frames('research-agent', 'body');
console.log(workspace.filesDir, frame.frame_hash, scan.total, scan.trust);
```

- `list()` / `get(agentId)` read validated metadata without creating workspaces.
  Missing `get` returns `null`. Metadata responses explicitly carry
  `verification.status: "not-scanned"` and do not claim frame verification.
- `ensure(agentId)` atomically creates a complete workspace or returns its
  existing identity unchanged. It never replaces missing/corrupt state or user
  files. Creation emits, verifies, persists, and actually scans its genesis
  before publishing the directory. Idempotent calls verify the existing body
  chain without emitting another creation event. Existing streams are not reset.
- `resolvePath(agentId, 'files' | 'tasks', relativePath)` confines content paths
  to that agent. Portable components start with a letter/digit and contain only
  letters, digits, dots, underscores, or hyphens (128 characters per component,
  1024 total). Dot segments, trailing dots, links, control characters, encoded
  separators, and device names are rejected. Missing parent directories are
  not created. This is an artifact-path API, not action persistence: writing
  bytes through a returned path does not create a verified task or file-history
  event. Producers must commit a canonical frame before presenting an artifact
  as a completed action.
- `frames(agentId, stream = 'body')` loads **all committed frames** and runs
  the canonical chain verifier against the manifest's trusted genesis and
  persisted head. Every indexed wave address must also match. The original
  creation frame must still bind the public identity and stream IDs; mutation
  and content-path operations enforce this too. Empty memory/swarm streams
  report `total: 0`, `head: null`, `trust: null`, and
  `verification.status: "empty"`, not a conformance success. A missing body
  creation frame is an explicit error, not an empty successful scan.
- `appendEvidence(agentId, input)` uses the canonical evidence builder and
  profile from `src/rapp`: `body.pulse` with `openrappter-evidence/1` payloads
  under the accepted protocol authority. `dataHash` is the caller's lowercase
  64-hex content address; raw artifact contents are not included.
  Optional `referenceHashes` must be sorted, unique lowercase 64-hex addresses.
  Optional `utc` is RAPP/1 UTC with milliseconds; otherwise the server clock is
  used. Time regression and duplicate evidence payloads are refused.
  `workspace.created` is reserved for atomic creation.
- `appendFrame(agentId, stream, frame)` ingests already-issued frames using the
  same canonical verifier. Body frames must satisfy the evidence profile;
  memory frames use the accepted memory-stream profile. Nonempty swarm streams
  require a trusted `verifySwarmSignature` callback in `WorkspaceStore` options.
  Unsigned swarm frames, unregistered kinds, and generic re-genesis are never
  permitted. The store does not invent a swarm signing protocol or issuer.
- `commitWorkspaceEvidence(persistence, agentId, input)` is the tested
  cross-component commit contract for producers: append through
  `WorkspaceFramePersistence`, capture the persisted checkpoint, independently
  scan and verify the complete canonical evidence chain, and return the exact
  committed frame only if its receipt is present. Emission-only results,
  missing/rolled-back scans, conflicting addresses, and a false `"verified"`
  flag cannot stand in for persistence.

Append and content-path operations require an existing workspace. Successful
appends return the actual verified frame. Evidence appends are not an
idempotency-key API: an already committed identical payload is explicitly
rejected rather than duplicated.

## Authenticated gateway RPCs

All six methods are installed by the production
`GatewayServer.registerBuiltInMethods()` path with `requiresAuth: true`.
They work over the existing HTTP JSON-RPC and WebSocket transports. Configure
gateway token/password authentication; HTTP uses the usual credential and
WebSocket clients must complete the authenticated `connect` handshake.
Explicit `auth.mode: 'none'` retains the gateway's trusted-local behavior.

| Method | Parameters | Result |
| --- | --- | --- |
| `workspace.list` | `{}` | `{ workspaces }` |
| `workspace.get` | `{ agentId }` | `{ workspace }` or `{ workspace: null }` |
| `workspace.ensure` | `{ agentId }` | `{ workspace }` |
| `workspace.frames` | `{ agentId, stream?, offset?, limit? }` | `{ agentId, stream, streamId, frames, total, head, trust, verification, offset, limit, nextOffset }` |
| `workspace.appendEvidence` | `{ agentId, eventKind, subject, dataHash, referenceHashes?, utc? }` | `{ frame }` |
| `workspace.appendFrame` | `{ agentId, stream, frame }` | `{ frame }` after canonical verification and durable commit |

Frames default to `stream: "body"`, `offset: 0`, `limit: 100` (maximum 1000).
Pagination happens **after full-chain verification**, so an omitted page cannot
hide tampering. RPC callers cannot override roots, identities, heads, profiles,
or authority. Invalid inputs return `-32602`; workspace failures include a
machine-readable `error.data.workspaceCode`, and canonical verifier failures
also include `frameCode`, `verificationStep`, and `frameIndex`.

An embedding host can use `gateway.setWorkspaceStore(store)` to install a
trusted store with a swarm signature verifier. Normal body/memory operation
requires no setter or extra registration.

## Required action-producer and presentation contract

`WorkspaceFramePersistence` is the exported integration boundary for producers
outside this subsystem. Do not introduce separate task-status JSON, VM logs,
approval histories, audit envelopes, or workspace event journals as an
alternative source of truth. Existing canonical frames represent these facts:

| Producer fact | Canonical frame / family | Persistence |
| --- | --- | --- |
| Workspace creation | `body.pulse` / body, evidence `workspace.created` | Owned by `ensure`; exactly once |
| Task, action, local VM lifecycle, approval/audit observations | `body.pulse` / body, canonical evidence `event_kind` such as `task.completed`, `vm.started`, `approval.granted` | `commitWorkspaceEvidence` / `workspace.appendEvidence`, followed by verified read-back |
| Chat turns, tool invocations, memory writes | `memory.chat-turn`, `memory.tool-call`, `memory.save` / memory | Canonical `buildRappFrame` with the verified memory head, then `appendFrame` / `workspace.appendFrame` and scan |
| Signed swarm coordination | Accepted `swarm.*` kind / swarm | External signer, `appendFrame`, explicit trusted signature verifier, then scan |

`task.completed` and `approval.granted` are application **payload** event kinds,
not invented frame kinds. Approval observations do not grant authority or
replace the real approval/security gate; these chains remain integrity-only.
Use unique operation subjects/content addresses and canonical reference hashes
to connect related observations. Artifacts under `files/` and `tasks/` are
content, not event/status stores. A failed or unacknowledged frame commit must
not advance a derived task/VM/approval state; orphan artifact bytes do not
prove completion. Recovery must inspect committed frames before retrying an
external side effect.

The interface's `frames()` method returns a full committed chain. A remote
adapter must assemble all RPC pages needed for its captured checkpoint before
independent verification; a page or an append receipt alone is insufficient.
Concurrent append-only growth beyond that checkpoint is acceptable, rollback
is not. The integration tests exercise real disk persistence, all three
stream families, causal evidence references, disconnected receipt-only
producers, and falsely labeled empty scans.

UI/other consumers may show **derived** views, but must label the returned
RAPP/1 verification state and its scope:

| `verification.status` | Required meaning |
| --- | --- |
| `not-scanned` | Metadata response, **RAPP/1 not verified**; no frame-scan evidence accompanies this view |
| `empty` | Selected stream has **no RAPP/1 frame evidence**; zero is not a compliance pass |
| `verified` | **RAPP/1 verified, integrity-only** for the selected stream; `scannedFrames > 0` and the canonical trust assessment apply |
| RPC/verification error | **Verification failed or unavailable**; never substitute an empty or successful result |

The verified count covers the full server-side scan before pagination, not
only the displayed page. Verification of one stream does not attest that
every external runtime action has been recorded. No UI code is changed here;
these response fields and their producer/consumer contract are tested at the
production gateway boundary.

## Durability, recovery, and trust boundaries

Creation stages the complete private directory and verified lifecycle frame on the same filesystem and
publishes it with one rename. Concurrent processes serialize writers per
agent, while different agents remain independent. Readers select a complete
manifest snapshot without taking the writer lock.

An append verifies the existing chain, the newly emitted/received frame, and
the serialized candidate chain **before** publishing anything. Immutable
frame objects are fsynced and published without overwriting an existing
object. An atomic, fsynced manifest replacement is the single commit point
for the new index and checkpoints. Directory fsync is used where supported;
the filesystem must support atomic rename and hard links.

An interrupted append may leave an unreferenced object. Such objects are not
committed frames and are never adopted by a scan. A retry with identical
frame bytes can safely reuse that object. Crashed writers may leave a lock;
the default wait is bounded to five seconds (`lockTimeoutMs` is configurable,
1–60000 ms). Locks are never stolen automatically: inspect the recorded PID
and confirm no writer is active before removing a stale lock. Unpublished
`.create-*` directories can likewise be removed after writers have stopped.
Corrupt/deleted committed objects, changed identities, conflicting anchors,
or invalid signatures fail explicitly; no operation silently repairs history.
Workspaces made by a pre-lifecycle implementation are not silently blessed:
missing or mismatched creation evidence requires an explicit migration rather
than a fabricated, backdated event or rewritten chain.

Frames are bounded to 1 MiB and each stream to 10,000 committed frames to
bound local scans; reaching a limit fails without truncating history. Back up
identity, manifest, and committed objects together. Do not edit a manifest
to reset a sequence or bypass a limit.

These are local **integrity-only**, non-promotion-grade chains. The manifest
is the trusted local checkpoint; replacing the entire trusted store with an
older valid backup cannot be detected without an external checkpoint.
Filesystem isolation is not an OS sandbox or per-agent authentication:
trusted gateway credentials administer all local workspaces, and code running
as the same OS user can modify files. External execution producers must adopt
the integration contract; unrelated legacy runtimes, UI, desktop, and VM
execution code are not changed by this subsystem.
