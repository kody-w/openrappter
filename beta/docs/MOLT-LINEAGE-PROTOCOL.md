# Molt Lineage — `molt-lineage/1.0`

Every on-device Brainstem is a **runtime in one compatibility family**. It may
adapt agents to the device, user, and current task while retaining the ability
to return to a common working baseline. Molt Lineage is the contract that lets
instances specialize independently without losing safety, availability, or
fleet convergence.

> **Standard.** The general, platform-neutral form of this design is
> `gitprotocol-molt(5)`, published independently as
> **[git-molt](https://github.com/kody-w/git-molt)** — "git for agents". This
> document is the Frontier's implementation; its registered conformance profile
> is [`rapp-lineage`](https://github.com/kody-w/git-molt/blob/main/spec/profiles/rapp-lineage.md).

This is a **protocol, not a library**. It is downstream of the Brainstem
`CONSTITUTION.md` and the `rapp/1` spine; where they conflict, the kernel's law
wins. Amend by a PR that changes this file in the same commit as the behavior it
governs.

**Cardinal rule:** *the Grail baseline is never mutated in place.* Everything an
instance grows is an **additive overlay** composed onto that immutable baseline at
load time. If a change edits a baseline agent's bytes on disk, the pattern has
failed.

## What ships in 0.1.0-beta.7

One live surface implements this protocol: `beta/electron/lineage-store.mjs`,
wired through `route-manager.mjs`. The same per-locus store owns ring identity,
the default and named-environment HEADs, fail-safe composition (last-good →
baseline), the seeded ContextMemory ring 1, rollback/restore, fast-forward-only
promotion, drift detection, and the hash-chained promotion journal. There is no
parallel ALM store and no second identity or copy of a ring.

The running Frontier drives all of those operations through its existing chat
and IPC lineage control surface. With no named environments or promotions, the
plain `HEAD` / `PRIOR_HEAD` files and composed bytes are unchanged.

---

## Definitions

- **Factory baseline (ring 0).** The pristine Grail factory agents on disk —
  the three factory agents plus `basic_agent` — byte-for-byte identical on every
  instance. This is the compatibility standard and recovery floor. It is pinned
  in a **baseline manifest**: `ancestor_rappid → sha256 → source`.
- **Molt.** A mutation of exactly one agent, produced by growth (the Molter's
  `generate` / `mutate`) or dropped in by a person. It descends from one ancestor.
- **Ring.** One generation in an agent's lineage. Append-only; never deleted.
- **Frame.** A ring made portable: a self-contained snapshot (`source` +
  lineage metadata + `rappid` + `sha256`) that can be hot-loaded on its own. Every
  frame is a valid still of the runtime at that generation.
- **Agent locus.** One agent's independent lineage. Each agent molts on its own
  timeline, at its own cadence, under its own policy — memory pinned at ring 0
  while news molts daily, or the reverse; it is per-agent and per-use-case.
- **HEAD.** The pointer, per agent locus, to the currently live ring.
- **Ancestor rappid.** The lineage primary key, derived from the agent's stable
  **name** alone — identical across all instances (the cross-instance agent
  key). It deliberately does **not** include the baseline's content:
  folding content in would make it a *version* key, so a routine Grail upgrade
  would mint a new ancestor and silently orphan every molt the user had grown. A
  lineage must survive its baseline being updated. The baseline's digest is still
  recorded per locus and per ring as provenance.
- **Ring rappid.** A per-generation id, hash-chained to its parent:
  `ring_rappid = mintRappid(parent_rappid + sha256(source) + ancestor_rappid)`.
  Because each ring cryptographically commits to its parent and its bytes, the
  tree-rings are **tamper-evident** — a ring cannot forge its place in the lineage.

## The model

An agent's lineage is an **append-only, content-addressed log** (git-for-agents):
rings keyed and partitioned by `ancestor_rappid`, each ring naming its
`parent_rappid`, with a movable `HEAD`. Composition reads `HEAD` and lays down that
ring; growth appends a new ring and advances `HEAD`; nothing is ever overwritten.

Loci are **independent**: a bad molt in one agent can never touch another, and each
agent time-travels on its own axis.

### Per-locus policy

Each locus carries a policy in its `locus.json`:

- **`mutable`** (default) — the locus molts normally.
- **`pinned`** — the locus never leaves its Grail baseline, however many rings
  exist. `setHead` refuses to move it, `resolveLive` serves the baseline
  regardless of HEAD, and a fleet-wide `restore` honors the pin rather than
  fighting it. History is still append-only — a ring may be *recorded* for a
  pinned locus, it simply can never be made live until the locus is unpinned.

This is what lets one Brainstem freeze its memory agent at ring 0 for life while
a news agent molts every day — or exactly the reverse. Policy is per agent, set
with `setLocusPolicy(ancestorRappid, "pinned" | "mutable")`.

## Composition — the "monkey-patch," done safely

The Frontier already materializes each worker's `AGENTS_PATH` by hardlinking-or-
copying agent sources (`route-manager.mjs` `hardlinkOrCopy`). That is the overlay
point. Per agent, materialization selects the **live ring**:

- if a *verified* molt sits at `HEAD` over the Grail ancestor, materialize that
  ring's frame;
- otherwise, materialize (hardlink) the **pristine Grail ancestor**.

The kernel then loads the composed directory and neither knows nor cares which
agents are molted. **Grail on disk is never touched.** Rollback is composition
choosing an earlier ring; there is nothing to un-edit.

Before the last-good tier reuses a cached descriptor, it reconciles every cached
lineage entry with the selected environment's current HEAD, verified chain, and
pin policy. A cached parent may remain as the fallback for a broken descendant,
but rollback, pinning, branch movement, or corruption drops that cached ring and
recomposes the fallback from the live store before any bytes are served.

## Non-destructive pointer movement

Because the log is append-only and `HEAD` is a pointer, an instance can move
through its entire growth history at will:

- **Back:** walk `parent_rappid` from `HEAD` to any target ring, or jump straight
  to `ancestor_rappid` for the factory baseline (O(1)).
- **Forward / fork:** point `HEAD` at a later ring or branch a new ring from any
  past ring.
- **Restore is the inverse of baseline, not a fast-forward.** A rollback records
  the generation it displaced, so restoring returns the locus to exactly where it
  was — a deliberately-parked older generation is never silently replaced by
  whatever is newest. A forward HEAD move clears that rollback record, and restore
  consults it only while HEAD remains at baseline. With nothing displaced, restore
  adopts the newest verified ring.

Baseline → latest verified generation → baseline remains available within one
chat, with every selected frame valid.

## Failure modes and safeguards

| Failure mode | What it is | Safeguard |
|---|---|---|
| **Invalid lineage** | An unverifiable or nonfunctional candidate is promoted as valid. | The **validation / compile gate** below plus molt isolation |
| **Runtime outage** | The selected composition cannot run. | **Fail-safe composition** (never serve an unverified ring; fall back last-good → baseline) plus rollback |
| **Nonfunctional agent** | An agent loads but cannot perform its declared operation. | **Whole-set verification** at promotion time plus Ambient Context diagnostics |

## The validation / compile gate

Dynamic composition at runtime is how a system gets JavaScript-style
"undefined is not a function" *in front of the user*. Molt Lineage forbids it:
**all risk is moved to a promote-time compile step, and runtime is a pure load of
an already-checked artifact.**

A ring is promoted to *live* only after passing an **isolated verifier**:

1. **AST verdict (trusted, unforgeable).** The parent *parses* the candidate — it
   never executes it — and passes it only if it statically (a) imports `BasicAgent`
   from the kernel base module and never rebinds that name (the base is the genuine
   kernel class, not a `BasicAgent = object` decoy), (b) defines a class
   subclassing it, and (c) that class defines its own `perform()` — **a molt that
   cannot act is refused.** This is the functional validation.
2. **Correctness signal (advisory).** A disposable subprocess imports and
   instantiates the candidate; the parent reads only its **exit status**, never any
   byte it writes. A candidate cannot forge a pass through what it prints, an
   inherited fd, or `os._exit()`.
3. **Whole-set validation.** Before a composed `AGENTS_PATH` goes live, the entire
   set (baseline + every live overlay) is dry-loaded together: no duplicate tool
   names, no import collisions, every agent instantiates. Interactions are checked,
   not just individual files.
4. **Bounded ingest.** Every ring entry path enforces the same 512 KiB source
   ceiling before persistence or kernel materialization, including independent
   twin compositions.
5. **Atomic blue-green swap.** The new set is built in a staging directory,
   validated, and only then swapped in **between** requests — never mutated in
   place while serving. A half-composed state never reaches a user; if validation
   fails, the current good set keeps serving.

Reference implementation of the AST verdict + isolated correctness signal:
`_verify` / `_ast_agent_verdict` in
`beta/frontier/rapplications/molter/agents/molter_agent.py`.

## Lineage integrity

- **Single lineage.** Every ring descends from exactly one `ancestor_rappid`; the
  lineage marker is conserved through every generation. Two different ancestors
  are never merged into one agent.
- **Verified sources only.** The gate confirms each live ring is a valid,
  mutable source for a later generation.
- **Safe transfer.** When an instance seeds a twin or rapplication, the target
  receives only verified live rings plus the Grail baseline. The target's own
  materialization re-applies the fail-safe rule, so an invalid transferred
  reference falls back to Grail.

## Fleet reassimilation

Local devices maintain their lineage histories independently. Fleet
reassimilation merges local frames back into the shared history:

1. **Verified ingest.** Only frames that pass the validation gate are reassimilated
   — the gate applies on the way *in*, not just on the way out.
2. **Merge by shared ancestry.** Because every frame is keyed by `rappid` and
   rooted at the shared `ancestor_rappid`, lineages that share an ancestor can be
   compared and merged; the hash-chain makes merges verifiable.
3. **Branch, never force-cross.** Lineages that cannot merge cleanly stay as
   branches off the shared ancestor — never force-crossed into a hybrid.
4. **Baseline is the convergence point.** However far the fleet diverges, the
   Grail baseline is identical everywhere, so any two instances can return to
   the common ancestor and re-apply compatible frames. Convergence remains
   available even if a branch is abandoned.

## Layering over a Grail brainstem — the passthrough contract

Molt Lineage is a **big release that must not break a simple Grail brainstem.** The
layer is additive and **inert by default**: with no molts it does nothing, and a
plain Grail brainstem — even one with no lineage store, no baseline manifest, and
no Frontier around it — boots and chats exactly as it does bare. Grail is a black
box the layer feeds a valid `AGENTS_PATH`; it never modifies the kernel or its
agent-loading contract.

1. **Transparent passthrough.** The layer overlays bytes only for an agent it has
   an explicit *verified* live molt for. Every other agent — including ones it has
   never seen — passes through untouched: never dropped, renamed, or reordered. It
   can only ever substitute, never subtract from, what Grail would have loaded.
2. **No-op with no molts.** An empty/absent/corrupt lineage store yields a composed
   `AGENTS_PATH` byte-identical to today's factory compose. Source selection happens
   before content-addressing, so the composition hash reflects exactly what shipped.
3. **Kill-switch.** One environment flag forces pure Grail passthrough — total,
   redeploy-free rollback of the whole layer if anything smells wrong in the field.
4. **Fail-safe degradation.** Any store error, corrupt ring, or failed whole-set
   validation falls back to the pristine baseline = current behavior. The layer can
   never make an instance *worse* than bare Grail.
5. **Realized safely.** Source selection is hash-aware (so the cache and fingerprint
   stay correct); byte placement is physical only. The composed directory is built
   in staging, whole-set dry-loaded, and swapped in atomically between requests —
   a half-composed set never reaches a running kernel.

## Enterprise ALM — environments, promotion, and drift

A molt made directly in production that dev never sees, then a dev promotion built
on a different base, must not "break at literally the worst time." Content-
addressing is what prevents it: because `ring_rappid` is deterministic, the *same*
molt has the *same* rappid in every environment, so divergence is detected exactly.
Enterprise ALM is part of the live `lineage-store.mjs`; the Frontier composes
directly from the selected environment's HEAD.

Each locus keeps one ring store and these pointers:

```text
<lineage-root>/<locus>/
├── locus.json
├── HEAD                         # default environment; unchanged legacy layout
├── PRIOR_HEAD                   # default rollback inverse
├── HEAD.<env>                   # named environment
├── PRIOR_HEAD.<env>             # named rollback inverse
├── promotions.json              # hash-chained promotion journal
└── rings/<ring>/source.py + meta.json
```

`default` always maps to plain `HEAD`; no migration or rename occurs. Named
environment labels are normalized to
`[a-z0-9][a-z0-9._-]{0,31}`. `RAPP_LINEAGE_ENV` selects the environment used by
composition and defaults to `default`.

Legacy content-derived loci migrate ring by ring. A ring is re-minted only when
its recorded source digest matches its actual bytes; corrupt rings are skipped
with `lineage-migration-skipped-ring` telemetry, HEAD moves to the nearest
surviving verified ancestor, and the legacy directory is archived even after a
partial migration so the same bad input is not retried on every boot.

1. **Environments are HEADs, not copies.** dev, staging, and production each pin
   their own `HEAD` per agent locus into the *same* content-addressed ring store.
   Rings are environment-independent; "the same molt" is one object everywhere.
2. **Promotion is a gated three-way merge.** Promote = advance the target
   environment's `HEAD` toward the source's, checked against their common ancestor.
   **Fast-forward only** when the target has not diverged. If the target holds a
   ring the promotion did not build on (a production-only molt), it is a
   **CONFLICT → refuse**, naming the diverging rappids and requiring explicit
   reconciliation (rebase the production molt onto the new base, or a deliberate,
   recorded override). Never a silent overwrite: branches do not force-cross,
   applying the same common-ancestor rule across environments.
3. **Drift is detected before promotion.** The target's live ring rappids are
   compared against the base the promotion expects; any unexpected ring is drift and
   the promotion refuses with a precise diff — not a runtime surprise.
4. **Baseline drift is explicit.** Every ring records the Grail baseline digest
   it grew from. A later Grail upgrade emits one `lineage-baseline-drift` event
   per affected ring per boot and marks the locus drifted in environment reports.
   User-authored rings keep serving; a stale `author: "frontier"` seed yields to
   the new baseline until Frontier seeds a ring against that baseline.
5. **Fail at promote, not at runtime.** The whole-set dry-load validation runs
   against the *resulting* target composition at promotion time (in a staging
   materialization). A break surfaces before the production swap; "the worst time"
   becomes "the promotion refused, and here is why."
6. **Hash-chained audit trail.** Hash-chained rings plus append-only promotion
   records (from/to `ring_rappid`, environment, actor, UTC) give ALM an
   internally verifiable history of every change in the present journal. A
   corrupt promotion record refuses every promotion outright (no HEAD moves),
   verification reports the corruption instead of ok, and the corrupt bytes are
   preserved as evidence — never appended over. The journal is not externally
   anchored in this release; deployments that must detect full-file deletion or
   truncation must persist the latest digest in an immutable audit sink.

### Frontier controls

The Brainstem chat interceptor recognizes exact commands before sending ordinary
messages to Grail:

- `baseline` and `restore` move the active environment's HEADs;
- `environments` lists each locus and its default/named HEADs;
- `promote <from> <to>` runs isolated, fleet-wide fast-forward promotion;
- `drift <env>` compares that environment with `default`.

Control-word change counts compare the effective resolved artifacts, not raw HEAD
file strings. Repairing a pointer that already fell back to the same baseline
bytes is reported as unchanged rather than as a successful restore.
HEAD-moving chat commands never wait behind an in-flight route lifecycle lock:
the pointer moves immediately, the restart is scheduled for lifecycle idle, and
the pending reply says the change takes effect as soon as the current task
finishes. No-op and refused commands do not restart the active worker.

The words are configurable with `RAPP_BASELINE_SAFEWORD`,
`RAPP_RESTORE_WORD`, `RAPP_ENVIRONMENTS_WORD`, `RAPP_PROMOTE_WORD`, and
`RAPP_DRIFT_WORD`. `RAPP_MOLT_LINEAGE=0` is checked at every invocation and
every HEAD-writing path reports refusal without moving a pointer.

Electron exposes the same ALM operations through `beta:lineage-command`,
`beta:lineage-environments`, `beta:lineage-promote`, and
`beta:lineage-drift`. The preload names are `lineageCommand`,
`lineageEnvironments`, `lineagePromote`, and `lineageDrift`; command results
retain the full report, including changed, unchanged, conflict, failure, and
disabled state.

## Laws

1. **The factory baseline never drifts.** Baseline agents are immutable on disk; all growth
   is additive overlay. Instance-level variation is unbounded; baseline-level
   drift (baseline mutation) is forbidden.
2. **One lineage per ring.** A ring descends from exactly one ancestor; ancestors
   are never fused.
3. **Validation gate.** A ring is promoted only if it is a valid, functional,
   genuinely descended agent. Invalid-lineage molts are refused.
4. **Compile before run.** All verification is promote-time and isolated; runtime
   is a read-only load of a pinned, pre-validated artifact. No hot-mutation of live
   modules.
5. **Fail-safe composition.** Only verified rings go live; composition falls back
   last-good → baseline; the composed set is always loadable.
6. **Non-destructive log.** Rings are append-only and content-addressed. History is
   never rewritten; the baseline is always reachable.
7. **Verified ingest.** Reassimilation carries only verified frames; un-mergeable
   lineages branch, they do not force-cross.
8. **Inert over Grail.** The layer is passthrough by default and requires none of
   its own machinery to exist; with no molts a plain Grail brainstem is unaffected,
   and any failure degrades to bare-Grail behavior. It substitutes, never subtracts.
9. **Promotion is gated, never forced.** Crossing an environment boundary is a
   three-way merge against a common ancestor: fast-forward or refuse-with-a-diff.
   Drift and conflicts fail at promotion time, never at runtime.

## Cross-references

- `CONSTITUTION.md` — Article I (factory agents plus molt isolation: molts live
  only in isolated twins, never in the unchanged Brainstem) and Article II
  (runtime capabilities).
- `AMBIENT-CONTEXT-PROTOCOL.md` — the diagnostics layer that surfaces a broken
  or failed agent in chat.
- `UI-AUTOSTEER-PROTOCOL.md` — the sibling protocol for driving an application
  through its surface.
