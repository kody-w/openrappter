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

outbound ports: Copilot SDK, shared Brainstem, estate pointers,
               explicit external effects, private channels, canonical Hive
```

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
```

No message database, workspace database, identity alias, task database, schedule
database, mutable root manifest, cache authority or Egg format exists. The
canonical body genesis **is** the mint-once rooted bot definition. Catalog,
visibility, conversation, internal scopes, routine state and attention are
reconstructed projections. All hashes, signatures, kinds, sequences, predecessor
particles and wave links are verified before use.

One reviewed internal operation publishes one complete successor frame. A
private process-shared lock serializes read/compare/append. A fsynced staged file
is published by non-overwriting hard link, its staging link is removed, and the
directory is fsynced. Durable frame files are never unlinked or replaced. A lost
acknowledgement is resolved by the canonical operation receipt, not re-execution.
An interrupted writer, incomplete root, stream gap, unknown file, invalid frame
or stale expected head refuses; no lock stealing or history “repair” occurs.

An explicit alternative branch carries its whole canonical chain, preserving
the exact frame bytes and original stream identity. It is not silently merged,
flattened, selected, or promoted to a bot. No unification protocol is invented.

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
