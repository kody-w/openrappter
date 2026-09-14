# Binding architecture: Autonomous Agent First

## Dependency direction

```
CLI / stdio / future passive projection
                  ↓
          headless conversation core
                  ↓
       bot-scoped intents and projections
                  ↓
        canonical frame repository
                  ↓
 rev-15 authority + adopted wire/crypto primitives

owner-launched recurrence scheduler
        ↓ exact root allowlist + durable operational lease
 recurring canonical-recap boundary
        ↓ deterministic occurrence operation ID
 same canonical frame repository

outbound ports: Copilot SDK, shared Brainstem, estate pointers,
               explicit external effects, private channels, canonical Hive
```

## Core requirement: provider-neutral AI-driven projections

The experience is driven by the AI's work, not a fixed renderer workflow.
Copilot, Claude, Hermes, Scout, Grokbot and future hosts receive one portable
`skills/rapp-work-bot/SKILL.md` and connect to the **same canonical root GUID**.
An authenticated MCP/stdio publication layer accepts public conversation,
activity, evidence, attention and closed focus/layout/card/progress intents.
The built-in Copilot inference adapter is separate; publication never starts a
model, switches providers, or imports a client's private memory.

This layer composes existing signed `memory.chat-turn`, `memory.tool-call` and
`memory.save` frames. Its client grants, scopes, attribution, causal parents,
idempotency and conflicts are canonical data; there is no parallel UI state.
Credential instructions grant nothing. Root-backed signatures attest a verified
scoped client capability, not an invented vendor/person signature.

The accepted view vocabulary contains only canonical references and closed
enums. No HTML/JS/CSS, executable components, DOM selectors or coordinates enter
the view contract. Concurrent view heads remain visible conflicts; consuming
another client's head requires separate resolution authority. Unsupported hints
cannot discard an otherwise valid work publication.

The future UI is a disposable subscriber to bounded canonical cursor events.
Queues, connection identity and cursors in memory are transport bookkeeping,
not durable authority. Reconnect replays frames or explicitly requests resync,
and a fresh view reconstructs identically without a model call. A tiny test
render-model consumer proves transforms; it is not product UI.

See [AI projection API](AI_PROJECTION_API.md) and
[milestones](MILESTONES.md). The implemented transports are MCP stdio and native
stdio events; no loopback HTTP/WebSocket listener or host configuration is
silently installed.

`next/` is a new root, not a compatibility extension of the app. There is one
trusted TypeScript core. Adapters cannot authorize themselves. Only
`src/canonical.ts` crosses into `packages/rapp1/dist/index.js`; it adopts wire,
identity, canonicalization and signing functions, **not** that package's selected
rev-14 trust report. The old package remains unchanged for the old app.
`adopted-primitives.json` binds every adopted source byte. Builds force a fresh
primitive compilation. The rev-15 authority and exact reference checker are
independent verification boundaries; the frozen kind registry/wire must agree.

## Sole durable state

The disk adapter stores ordinary eleven-field RAPP/1 frames:

```
<explicit-private-store>/bots/<root-rappid-tail>/
  body/frames/000000000000.json
  memory/frames/000000000000.json …
  swarm/frames/000000000000.json …
  branches/<family>-<head-wave>/frames/000000000000.json …
  scopes/<canonical-source-key>/frames/000000000000.json …
  scopes/<canonical-source-key>/branches/<head-wave>/frames/000000000000.json …
```

No message database, workspace database, identity alias, task database, schedule
database, mutable root manifest, cache authority or Egg format exists. The
canonical body genesis **is** the mint-once rooted bot definition. Catalog,
visibility, conversation, internal scopes, routine state and attention are
reconstructed projections. All hashes, signatures, kinds, sequences, predecessor
particles and wave links are verified before use.

The optional recurrence process has one non-authoritative operational sibling,
`<store>.scheduler/`, containing only bounded same-user per-root lease records.
It is not a schedule, claim or outcome database. Reviewed routines and completed
occurrences remain canonical source-owned frames. Startup reconstructs due work
from those frames, so restart catch-up does not replay a model or trust lease
contents as application state. Exact root allowlisting and available root signer
custody authorize the process; leases only fence competing scheduler hosts.

One reviewed internal operation publishes one complete successor frame. A
private process-shared lock serializes read/compare/append. A fsynced staged file
is published by non-overwriting hard link, its staging link is removed, and the
directory is fsynced. Durable frame files are never unlinked or replaced. A lost
acknowledgement is resolved by the canonical operation receipt, not re-execution.
An interrupted writer, incomplete root, stream gap, unknown file, invalid frame
or stale expected head refuses; no lock stealing or history “repair” occurs.
Recurring claims use the exact root/routine/occurrence tuple for that receipt.
Hidden roots and unresolved retained forks cannot produce scheduler successors.
No scheduler path enters provider, transcript, channel-delivery or external
effect approval code.

Private iMessage transport custody is a separate strict same-user runtime
sibling, not product state or an Egg component. Only an opaque reference and
public policy enter canonical frames; contacts, Shortcut selection and
credentials do not. Queues, preflight generations, cancellations, inbox
attention and outcomes remain source-owned canonical data. Reporting/invalidation
can authorize bounded internal queueing only; delivery is a separate explicit
irreversible operation. See `CHANNEL_CONTRACT.md`.

An explicit alternative branch carries its whole canonical chain, preserving
the exact frame bytes and original stream identity. It is not silently merged,
flattened, selected, or promoted to a bot. No unification protocol is invented.
Conflicting active/retained occurrences fence the affected root's semantic
projections and successors until canonical owner resolution; an `active` directory
is not authority. Only identical ancestry prefixes can accompany an unambiguous
selected chain. Raw forensic reopen retains both histories. See
`REVIEW_FOLLOWUP.md`.

The 64-root catalog bound is enforced inside creation/materialization before
directories or genesis are written, including hidden roots. Internal scope IDs
are mint-once per root: correction does not permit recreating another scope under
an old identity or parenting new work to its retired creator.

All new action exhaust is **source-owned** by its exact original internal
workspace/world scope. The root memory stream is not a copied central journal.
Global Estate, Librarian, collaboration, iMessage recap and Catch-me-up resolve
original source GUID/scope/stream/hash references. New recaps retain references
instead of copied activity text; peer dissent stays in the peer's signed public
turn. Causally closed source-head vectors drive paging/reconnect/replay, including
independently clocked streams and preserved source branches. Immutable old
centralized scope records remain explicitly `legacy-root-stream`. See
[source ownership](SOURCE_OWNERSHIP.md) for the binding invariant and gate.

## Observer and Brainstem

Observe/select/orient are transient and append nothing. Dormant particles do not
run models. An observation is an expiring root-scoped handle, never a carried
`verified:true` claim. Closing one root does not cancel another root.

One `SharedBrainstem` owns all transient root slots. It verifies the exact
host-selected `agent.py` reference before asking an injected binding to hotload
that GUID. Public context, policy and capability are root-scoped; no shared
mutable bot memory or hidden reasoning crosses the seam. `agent.py` is a
target-owned **contract**, not a substitute interpreter or a change to the
immutable external grail. The default external binding refuses honestly.

## Trust limitations

This is an owner-controlled local host, not an OS sandbox against a malicious
same-UID process. Hashes prove integrity, not factual truth or lawful authority.
Whole-store rollback cannot be disproved from that same rolled-back store;
production must bind an independently retained signed registry/checkpoint.
No synthetic test authority is a live adoption, contact permission, provider
authentication, source-write grant or GODD/DOGG transfer permit.

## Migration is a release gate, not an offline data seed

The new migration application uses the same trusted runtime/repository and
provider-neutral public stdio framing. It binds an exact signed selection to an
empty isolated profile and records staging/transaction evidence in an existing
owner-scoped canonical memory stream. No alternate migration database or Egg
format is introduced.

Whole compatible roots publish atomically with original GUID, frame bytes,
hidden recursive world and branch ancestry intact, plus an authorized successor
receipt. Pointer imports append bounded canonical events with original native/
manager provenance and honest compatibility classification. Incomplete rollback
retains canonical forensic data and removes no committed root.

A separate passive process consumes the real app's cursor events as each
root/world/pointer appears. The harness cannot seed the destination filesystem.
Both processes restart and reconstruct the same state from frames. Source file
and directory inventories must be unchanged. The static replay is a trusted
test artifact driven by captured data, not AI-provided HTML or product UI.

This fixture path is necessary but not sufficient: release remains blocked
until the same observed controlled-local migration passes under adopted
authority and final integration approval. See `MIGRATION_RELEASE_GATE.md`.

## Catch me up: passive canonical replay

Catch-up is a release gate over verified canonical frames/cursors, not an
agentic re-execution path. The pure replay module emits explicit provenance
grades, original source hashes and `rapp/1:particle` state/page digests.
The UI may fast-forward those returned states but owns no durable replay state
and may not call models/tools or mutate history to fill gaps.

The optional Omarchy lane uses an immutable read-only canonical ComputerBroker
snapshot adapter. Private GODD opt-in, the exact prior root-signed capture policy,
client capability and independently selected capture-origin/safety approvals
are mandatory. Actual approved guest bytes are recorded; command/diff summaries
are reconstructed; missing display remains unavailable. No host-screen, keyboard,
VM execution or capture method is exposed by replay. See `CATCH_ME_UP.md`.
