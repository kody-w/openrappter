# RAPP Quantum Drill — `rapp-qqdrill/1.0`

The execution engine under [dimension mining](DIMENSION-MINING.md). Mining decides *what* to race
and *what counts as winning*; the drill is *how many at once, and under what constraints*.

**The unit of drilling is a tile.** You drill a tile — not a repository, not a task — because the
tile is the thing that carries the capability, the lineage and the adapter that training lands in.

Given a tile, a task and a flag, a **drill** runs N candidate dimensions concurrently — each an
independent worker, each in its own workspace — and collapses to the one that captures the flag.

**On the spelling.** The doubled `q` is deliberate, not a slip: `ra`**`pp`**`-`**`qq`**`drill`
sets two pairs of descenders against each other so the word reads as though it were dripping. It is
a mark, and it is the one place in this protocol where something is chosen for how it looks.

**On the name.** The metaphor is superposition and collapse: hold many candidate dimensions at once,
then collapse to one on measurement. It is a metaphor and nothing more — there is no quantum
computation here, and the protocol makes no claim of one. What is real is ordinary parallelism with
strict isolation.

## What a drill is really doing: probing for a dimension that already exists

Reading a drill as "generate many candidates, keep the best" undersells it and gets the economics
wrong.

A drill **probes the space of reachable dimensions**. Most probes miss, which is cheap and expected.
A hit is not "we produced a good answer" — it is **finding a dimension that already solved this**,
whose frames can be merged in ([CRYSTALS](CRYSTALS.md)). And because merging is folding rather than
transferring, the capability arrives complete and already worn: instant transmission for that
situation.

That makes the economics asymmetric in the useful direction:

- **A miss costs compute** and leaves a trace of something that does not work.
- **A hit yields an entire pre-worn dimension** — not a candidate that must now be trained, but one
  that has already been used, in contexts this machine never saw.

### The space the drill searches is populated by publishing

This is where the public, permissive posture stops being ideology and becomes mechanism. Every
dimension anyone publishes is another place a drill can hit. A tile someone else wore into exactly
the shape you need is a hit waiting to happen — and the more of them exist, the more often drilling
returns a worn capability instead of an untrained candidate.

So the loop closes on itself: publishing populates the space, a populated space makes drills hit,
and hits are how a capability arrives already good. A private corpus makes drilling expensive; a
public one makes it lucky, and luck compounds with the size of the commons.

### It does not loosen the flag

A hit is still checked. A dimension that already exists is not thereby correct for *this* task — it
is a candidate that arrives pre-worn, and it captures the flag or it does not, evaluated by the same
checker as everything else. Finding something is not the same as it being right, and the drill's
discipline is precisely that it never confuses the two.

## Local instant transmission: the drill finds the pair, the fold merges it

Everything above describes a drill racing candidates. There is a second, cheaper use of exactly the
same machinery, and it is the one that runs most often: **drilling to find a pair.**

### The drill's only job is to find pairs

A drill searching for instant transmission does not generate, does not merge, and does not
assimilate. It searches for **a dimension trigger** — a key that addresses a frame in more than one
dimension — and its entire output is the pair it found:

```
{ "key": "<the trigger>", "here": "<local frame address>", "there": "<the other frame's address>" }
```

That is the whole result. The drill hands back a pair and stops. Everything after that is the fold's
job, and keeping the two apart is what makes this safe to run constantly: a search that cannot
mutate anything can be wrong as often as it likes.

### The key is a coordinate, and similar frames share one

The trigger is not a similarity score — nothing is guessed, nothing is embedded, nothing is
approximate. A quantum key is a **composite coordinate**, and matching is exact equality of its
components. What makes it reach further than a lookup is that the components can name *where* a
frame sits as well as *what* it contains:

| Component | What it fixes | What a match on it means |
|---|---|---|
| **frame rappid** | which capability this is a frame of | the same thing, in another dimension |
| **clock-speed key** | the cadence the dimension ran at | frames that line up tick for tick |
| **frame tick** | the position in that dimension's own time | the same moment of the same situation |
| **content digest** | the frame's bytes | two lines converged on an identical frame |
| further components | whatever else a dimension declares as shared | declared by the dimension, not inferred |

Because those components are coordinates and not only contents, **two frames that are merely similar
can legitimately share a key** — same capability, same clock, same tick, different history. That is
the hit that pays: frames of the same situation as it ran elsewhere, whose deltas differ, so folding
them produces something neither side had.

**Byte-identity is a key too, and a strong one.** A content digest is a perfectly good component,
and a hit on it is not a wasted hit just because the content adds nothing. Two frames with identical
bytes and *different ancestries* are proof that two lines converged independently — and what
assimilating one transmits is not content but **the other dimension's lineage, provenance and
wear**, attached to a frame this machine already holds. It is also the safest possible assimilation:
a frame asserting exactly what is already asserted cannot contradict anything downstream, so it
passes the compatibility check below by construction.

So the two kinds of hit pay differently and both pay: **matching on position** brings new deltas,
**matching on content** brings joined ancestry.

It is also the sense in which the situation is in two places at once, and why the transmission is
instant: the key already names where the frame is in both dimensions, so nothing has to be searched
for by content or reconstructed on arrival.

Most drills find nothing, which is the expected case and costs a search. A hit names one pair.

### An identical frame is a fixed point, and it calibrates the rest

A content-digest hit does something the joined ancestry alone does not: it **pins the two dimensions
against each other**, and that signal is what makes the local merge deterministic.

Two frames with identical bytes and different ancestries are a **fixed point** — a place where the
two lines are known to coincide exactly. Once one exists, the correspondence between everything
around it is no longer a judgement call:

- The local frame's tick and the incoming frame's tick are the same moment, so the **offset between
  the two dimensions' clocks is now known** rather than assumed.
- With the offset known, the neighbouring frames — the ones that are *not* identical, the ones
  carrying the deltas actually worth having — line up by arithmetic instead of by heuristic.
- Every further fixed point tightens the registration, and disagreeing fixed points are themselves a
  result: two dimensions that coincide at one tick and contradict at another have diverged in a way
  the trace should record.

So the calibration runs in the useful direction. The hit that transmits **no new content** is the one
that tells you exactly how to place the hits that do. It is why identical frames are worth drilling
for and worth publishing: they are the survey markers of the commons.

And it is what keeps the merge deterministic **locally**, with no coordination and no negotiation
with the other dimension. Given the same frames and the same fixed points, two machines that never
speak to each other compute the same joined frame — because the alignment was derived from the data
rather than decided by whoever merged first.

### Fidelity accrues with the length of the run

A fixed point is not binary, and the merge's confidence is not one number for the whole join.

**The longer the bytes match without contradicting anything downstream, the higher the sync fidelity
for that part of the merge.** One isolated identical frame is a weak pin — frames can coincide by
accident, especially trivial ones. A long uninterrupted run of identical frames, each of which also
contradicts nothing downstream, is not coincidence: the two dimensions were doing the same thing,
tick after tick, and the alignment across that whole span is as certain as the data can make it.

So fidelity is a property of a **span**, not of the join:

- A run **starts** where the frames begin matching and **ends** at the first contradiction. The
  length it reached is what it earned; the contradiction is recorded as the boundary rather than
  discarded, because where two dimensions stopped agreeing is the most informative thing about them.
- **Two dimensions can be tightly synced in one region and loosely aligned in another.** The same
  merge is deterministic across a long run and speculative in a gap, and the lineage records which
  region is which instead of averaging them into a single claim.
- **Long runs carry the short ones.** A gap bracketed by two high-fidelity runs is pinned from both
  sides, so its frames place by arithmetic even though they do not match. An unbracketed tail is the
  weakest part of any join and is marked as such.
- **What matched matters, not only how much.** A run of empty or no-op frames is cheap agreement and
  should not read as strongly as a run of frames that each asserted something. The record keeps what
  the matching frames actually contained, so a long trivial run cannot present as a long meaningful
  one.

This is why publishing frames that contain nothing novel is still worth doing. They lengthen runs,
and run length is the currency that turns a merge from plausible into determined.

### Every path is returned, because more merges is better

A local tick can arrive with several partners — a repeated payload matches every one of its twins,
and two dimensions can genuinely line up along more than one path at once. Those are not an ambiguity
to resolve. **Each path is a real diagonal and a real chance to merge, so all of them are returned.**

A diagonal is a constant offset: the other dimension's tick advances by the clock ratio for each of
yours. Grouping the fixed points by that offset separates the paths exactly, and each group yields
its own run with its own length and substance. The longest leads, because a long run is the strongest
evidence — but the others are alternates to merge along, not noise to discard.

This is the same statement as "a frame joined three ways is one frame with three ancestries", seen
from the search side. Choosing one path and dropping the rest would throw away merges that were
found and were valid.

### How far a drill goes is how long the person waits

There is no natural stopping point in a search over a commons, so the bound is the one that actually
matters: **patience.** A drill takes a budget — a number of pairs, a deadline — and returns what it
had when the budget ran out, saying plainly whether it finished or stopped.

Two properties make that safe to lean on:

- **Monotone.** The search is enumerated in a fixed order, so a bigger budget returns a *superset* of
  a smaller one. Waiting longer only ever adds paths. It never invalidates a pair already found and
  never reorders one out of the result.
- **Usable at any point.** Whatever came back merges immediately under the ordinary rules. A drill
  stopped after two pairs is a smaller drill, not a broken one, and resuming continues from exactly
  where it stopped rather than starting again.

So the honest thing to show a person is a search that keeps going and keeps handing back results,
with the choice to stop being theirs at every moment.

### The digest is the global lookup handle

A frame's bytes give it a handle that **anyone can compute and nobody has to assign**. Two machines
that have never met derive the same digest for the same frame, so the digest works as a global index
key without a registry, an account, or a namespace to reserve.

That is what makes the commons dialable. Publish frames under their digest — a static JSON index, a
raw file path, a gist ([`SUMMON-PROTOCOL.md`](SUMMON-PROTOCOL.md)) — and a drill on any
internet-connected device can look one up by computing the handle locally and asking for it by name.
No search, no crawl, no service in the middle.

**The digest is not the only lookup, and it should not be.** Any component of the key that both
sides compute the same way can carry an index: the frame rappid for "every frame of this
capability", the clock-speed key for "everything running at this cadence", the tick for a moment,
a declared shape name for a family. Which ones get published is a question of **convenience** —
index what the lookups you actually perform need, add more when a new lookup turns out to be common,
and skip the rest.

Two rules keep that open-ended set safe:

1. **An index is a convenience; the key is the key.** A lookup narrows the candidates. It never
   decides the merge — the compatibility rule above does, identically, no matter which index found
   the pair.
2. **A handle addresses a declared data object, never something executed on arrival.** Pulling a
   frame by digest fetches data that is checked, diffed and refusable before anything runs. The
   handle being globally computable is exactly why that matters: a global address that could execute
   on arrival would be a global attack surface.

### The hit pulls the full frame, not a summary

On a hit, the key is used to pull **the entire frame** from that address — its deltas, its lineage,
its wear, its provenance. Not a digest, not a diff of a diff, not a description of what is there.
Anything less would have to be reconstructed on arrival, and a reconstruction is exactly the thing
that is not instant.

### Compatible, or refused: backward fidelity

A pair is a candidate, not an assimilation. Sharing a coordinate makes two frames *comparable*; it
does not make the incoming one safe to fold in.

**The rule: a frame is assimilated only if it contradicts nothing downstream of the current frame.**

The local frame already has offspring — everything the line produced after it. Those descendants
were built on facts the local frame established. An incoming frame from another dimension carries
its own deltas, and some of them may assert something a descendant here already contradicts. Folding
one of those in would silently invalidate work that has already happened.

So before the merge, the incoming frame's deltas are checked against the downstream line: replay
what descends from the current frame, and if any descendant's preconditions no longer hold under the
incoming deltas, **the frame is refused, whole.** Not partially applied, not merged with the
conflicting deltas dropped — a frame with pieces removed is a frame that existed in neither
dimension, and the fold is not entitled to invent one.

Refusal is per frame, so a drill hit that returns several frames assimilates each on its own merits:
the compatible ones join, the contradicting ones are recorded in the trace with what they
contradicted. **A refusal is a result, not a failure** — it means the drill reached a dimension that
diverged past the point where its frames still fit here, which is worth knowing and worth keeping.

This is what backward fidelity means: **the merge may only add ancestry, never invalidate a
descendant.** Everything that held before the join still holds after it.

That guarantee is also what makes the join safe to be permanent. If no assimilated frame can ever
break a descendant, then nothing that merged ever needs to be un-merged — so an append-only lineage
with no un-merge operation is not a limitation being lived with, it is the shape the compatibility
rule allows. The seal argument below depends on this one.

### The merge is the Dream Catcher, unchanged

The two frames merge by the rules already specified in [`CRYSTALS.md`](CRYSTALS.md) — deltas, not
state; ordered on the composite key `(frame_tick, utc_timestamp)`; append-only, so neither side is
overwritten. **No new merge rule is invented for instant transmission.** Frames from a drill hit
merge exactly like frames from a parallel stream on another device, because they are the same kind
of object and the fold cannot tell where they came from. That is deliberate: one merge path means
one set of failure modes.

What comes out is a **joined frame**.

### The local line continues from the joined frame

This is the part that matters, and it is a lineage statement rather than a data one.

After the merge, **the local line's HEAD is the joined frame**, and everything the local line
produces from then on descends from it. Not from the local-only frame with a joined frame filed
somewhere beside it — from the join itself. The offspring of the joined frame are the offspring of
both dimensions, and the tile carries both dimensions' wear because it carries both dimensions'
frames.

Several keys can hit, so a frame can join along several paths. Each join is another merge under the
same ordering, so **multi-dimension paths are ordinary**: a frame joined three ways is one frame with
three ancestries, not three frames to choose between.

### Local first: the drill does not need the network

A drill for pairs runs against whatever frames this machine already has — imported tiles, the
binder, an `.egg` carried in on a stick, an earlier summon's cache. Instant transmission over a
public address is one source of pairs, not the definition of one. A machine that has been offline
for a week can still drill its own frames, find a pair among things it already holds, and assimilate
them into a joined frame that neither of them was.

That makes the offline path a real path rather than a degraded one, and it is what
[`CARTRIDGE-PWA.md`](CARTRIDGE-PWA.md) exchanges: frames, addressable by key, mergeable on arrival.

### Why a popped seal can never reset

[`ONE-TIME-SEALS.md`](ONE-TIME-SEALS.md) says a popped seal never resets. Local instant transmission
is *why* that is structurally true rather than merely enforced.

Popping a seal is not setting a flag that some later code could unset. It runs a drill, and if the
drill hits, the local line merges and continues from the joined frame. Resetting the seal afterwards
would mean disowning an ancestor that everything since has descended from — and an append-only
lineage has no operation for that. The seal stays popped because the line's ancestry changed, and
ancestry is the one thing here that only ever grows.

A machine that pops a seal and finds nothing is unchanged and can drill again. A machine that pops a
seal and hits has a different history, permanently.

### The same drill runs against global tiles

Everything above is written about frames, and **a tile is a frame**
([`RAPPID-TILE-PROTOCOL.md`](RAPPID-TILE-PROTOCOL.md), [`CRYSTALS.md`](CRYSTALS.md)). That identity
is literal, not a metaphor, so the entire mechanism applies one level up with nothing added:

- **The commons of published tiles is a drillable space.** Every tile anyone publishes is a
  potential pair for someone else's tile.
- **A global tile pairs by the same key** — same rappid, same clock, same tick, or an identical
  payload — and is refused by the same compatibility rule if it contradicts anything downstream of
  the local tile.
- **Assimilating it joins the tiles**: both lineages, both wear, both payloads, one tile. The local
  tile continues as the joined tile, and its offspring carry both ancestries.

So a capability that someone else wore into exactly the shape you need does not have to be found by
browsing, evaluated by reading, or installed as a dependency. It is a drill hit at a coordinate, and
what arrives is already worn.

And because tiles hold frames while themselves being frames, the mechanism is **scale-free**: drill
the commons for tiles, drill a joined tile's frames, drill within those. The same key, the same fixed
points, the same run-length fidelity, the same refusal rule at every level. There is one merge in
this system, and it works at whatever scale it is pointed at.

### Retroactive zoom: another dimension's finer clock is resolution on your own past

The coordinate contains a clock-speed key, and dimensions do not all run at the same clock. That has
a consequence worth stating on its own, because it is the most useful thing this whole mechanism
does.

**A dimension running at a finer clock holds more frames across the same span of your time.** Where
your line recorded one frame, theirs recorded ten. If a fixed point pins the two clocks and the ten
frames contradict nothing downstream, assimilating them **raises the resolution of your own history
at that moment** — from one frame to ten, in a past you have already lived through.

That is the zoom, and three properties make it safe:

- **It is retroactive but not revisionist.** The finer frames refine an interval; they may not
  contradict the coarse frame they refine, or backward fidelity refuses them. Your past gains detail
  it never had, and loses nothing it did.
- **It is addressable, so it is targeted.** You zoom on a span you name, because the key names the
  span. There is no need to pull a dimension wholesale to look inside one moment of it.
- **It is global.** The finer frames come from the commons — anyone who ran that situation at a
  faster clock and published it is a zoom source, including for a tile you already hold.

The clock keys relate by ratio and a fixed point pins the phase, so the placement of the finer frames
inside the coarse interval is arithmetic rather than a judgement. Zoom without a fixed point in the
span is guesswork and is refused as such.

### This is what closes DOGG–GGOD

The two faces — **DOGG**, the local line on this device, and **GGOD**, the public commons of frames
and tiles — have been described everywhere in these documents as an exchange. Local instant
transmission is the part that makes it a cycle rather than two directions of copying:

1. The local line produces frames. What it publishes goes out under computable handles; the private
   mapping stays on the device ([`ONE-TIME-SEALS.md`](ONE-TIME-SEALS.md)).
2. Anyone's drill can find those frames by handle. No account, no registry, no service in between.
3. A drill here finds a pair in the commons — a frame, a span, a whole tile.
4. Compatible frames assimilate locally. The local line continues from the joined frame.
5. What that line produces next is publishable in turn, and now carries both ancestries.

The direction of authority never reverses, and that is the whole safety argument: **global data is
always a candidate, and the local line always decides.** The commons cannot overwrite a device,
because the only way in is a merge that must contradict nothing the device already established. This
is precisely why the public face can be fully public — nothing about publishing grants anyone reach
into anyone else's line.

Read one way it is the private projection, read the other the public one. Same frames, same keys,
opposite direction of travel.

### This specifies the mechanism, not the policy

The protocol fixes what a key *is*, what a pair *is*, what may be assimilated and what must be
refused. It deliberately does **not** fix:

- **which components are indexed**, or in what order a drill probes them;
- **how substance is weighted** when scoring a run, or the threshold at which a span is called
  determined rather than speculative;
- **which coordinates are worth probing first** to make hits likely.

Those are policy, and they are where implementations legitimately differ and compete. Two conforming
implementations can search the same commons and hit at very different rates without either of them
being wrong, in the same way two search engines can index the same web.

What conformance requires is that **policy never changes the outcome of a merge.** Whatever a drill
chooses to probe, and however it ranks what it finds, an assimilation must still refuse anything
contradicting downstream, must still be whole-frame, and must still produce the same joined frame on
any machine given the same frames and fixed points. Policy decides *what you look at*. It never
decides *what is true*.

An implementation is therefore expected to make its policy replaceable, and to ship a plain default
that a reader can follow. This document is the mechanism; the default is an example, not the ceiling.

### What this is, named honestly

Content-addressed lookup, plus an op-based merge of append-only event streams, plus a lineage whose
HEAD advances to the merge. Each is a known primitive. What is not standard is the composition:
using the address itself as the pairing evidence, so that discovery and merge share one key and a
capability arrives already worn rather than needing to be trained on arrival.

## The contract

### 1. Isolation is mandatory, not an optimisation

Every drill gets its own workspace — its own checkout, its own home, its own state — and can see
nothing of any other. Drills that share mutable state are not independent, and a race between
dependent candidates measures interference rather than merit.

### 2. A drill never grades itself

The flag is evaluated **outside** the drill, by the same checker, identically for every candidate.
A worker reporting its own success is the failure mode this whole design exists to avoid: it turns
a race into a competition in self-confidence, which the most fluent candidate wins.

### 3. Nothing escapes the workspace

No drill may push, publish, install, write outside its workspace, or reach anything shared. A
speculative branch that mutates the real world is not speculative. This is the rule that makes it
safe to be wrong N times in parallel, and it is the one a fan-out of command-line workers is most
likely to break.

### 4. Bounded, declared before it starts

Maximum concurrency, wall-clock per drill and for the whole run, and spend per drill and in total —
all fixed in advance and shown while running. **This is not theoretical:** six parallel workers have
tripped a spend limit on this project before, mid-run, taking the good work with them. A drill that
can exhaust the budget is a drill that can lose everything it had already found.

Concurrency is bounded by what the machine has, not by ambition. Queue the rest.

### 5. Collapse is deterministic

First to capture the flag wins. Ties break on a rule stated before the run — fewest steps, least
spend — never on a judgement formed after seeing the results.

### 6. Losers leave their evidence

A failed drill folds with its trace and its diff intact. Most drills are meant to lose, and what
they tried is the most useful thing a mining run produces after the winner.

### 7. Killable, completely

A person can stop the whole drill at once: every worker dies, every workspace is cleaned up, and
partial work is discarded rather than half-merged. There is no state in which a killed drill has
changed something.

### 8. A drill finds; it never merges

A drill's output is a pair — a key and the two addresses it resolves. It does not fold, does not
assimilate, and does not advance any lineage. The merge happens afterwards, locally, under the
compatibility rule, by the same fold that merges frames from any other source.

Keeping the two apart is what makes searching cheap: a search that cannot mutate anything can run
constantly and be wrong every time without costing more than the search.

## A drill yields two things

Specifying only the winner misses half of what a drill produces.

1. **The collapse** — the dimension that captured the flag, promoted; or an honest report that
   nobody did.
2. **The wear** — the training that landed in the tile's adapter along the way, which persists
   regardless of who won or whether anyone did.

The second is the one that compounds, and it has a consequence worth stating plainly: **a drill that
captures no flag is not a wasted drill.** The tile came out of it needing less than it did going in,
and every folded dimension left a trace of something that does not work. A run that fails its flag
still returns two useful things, so "the flag was not captured" is a result rather than a loss.

That is also why the wear must be attributed. Training earned by drilling against a synthetic flag
is real and is not the same as a person using the tile; the lineage records which, and neither may
present as the other ([CRYSTALS](CRYSTALS.md)).

## What a drill run records

| Field | Why |
|---|---|
| `flag` | the exact condition, fixed before the run |
| `dimensions[]` | one entry per drill: its lineage, its workspace, its outcome, its spend |
| `winner` | the capturing dimension, and the tie-break rule if one was needed |
| `budget` | declared and consumed, so an overrun is visible rather than inferred |
| `folded[]` | the losers, with their traces |
| `wear` | training that landed, and that it was drilled rather than used |

## Proof obligations

A conforming implementation demonstrates, for instant transmission: a drill returns a pair and
changes nothing; the same key computed on two machines that never communicate resolves to the same
frames; an incoming frame that contradicts a downstream descendant is refused whole, with what it
contradicted recorded; a byte-identical frame from a different ancestry is assimilated and joins that
ancestry without changing content; two machines given the same frames and the same fixed points
compute the same joined frame; a run of matching frames ends at the first contradiction and is
recorded with the length it reached and what those frames asserted; a span covered by a long run and
a span covered by none are reported at different fidelity rather than as one number; and after a
successful join the local line's HEAD is the joined frame,
with no operation available that returns it to the pre-join frame.

And for the race: two drills cannot observe each other's workspace; a drill
that writes outside its workspace is prevented, not merely discouraged; the flag checker produces
the same verdict for the same artifact regardless of which drill produced it; a run stops at its
declared budget rather than exceeding it; a kill leaves nothing changed; and a run whose flag is
captured by nobody reports that honestly instead of promoting the best-looking loser.

## Status

**Split.** The two halves of this protocol are at different stages, and saying so is the point.

**Local instant transmission is implemented and proven headlessly.** `../electron/qqdrill.mjs`
carries the mechanism — coordinate keys, fixed points, run-length fidelity, alignment, the
compatibility rule, assimilation and retroactive zoom — and `../tests/qqdrill.test.mjs` has one test
per proof obligation above, all passing. Nothing in RAPP/1 changed to make it fit: the frame spec is
untouched, and the coordinate is computed about frames rather than stored in them.

Run it and watch it work: `node beta/scripts/qqdrill-proof.mjs`. It builds two real dimensions,
drills them, folds what may be folded, prints what it refused and what that frame contradicted, and
zooms a span with a finer clock.

Two facts the implementation established that inspection had not:

- **RAPP/1 binds `prev` to the head's `payload_hash`, not its `frame_hash`**, so identical payloads
  in two lines converge to identical frames after one tick. What distinguishes two dimensions running
  the same content is *when* they ran it, and the fixed point is about exactly that.
- **`prev_wave` is reserved for swarm streams** and is not a general second-parent field, so a join
  names the frames it assimilated in its payload. The payload is hashed into `frame_hash`, so that
  claim is bound just as tightly and the local chain stays single-parent and valid.

**The race is still specified only.** Nothing here runs N candidate dimensions against a flag. The
flag checker in [DIMENSION-MINING.md](DIMENSION-MINING.md) remains the piece to build first — without
it there is nothing to collapse on, and rule 2 cannot be satisfied. Related machinery that exists:
the single-contender race in `../electron/dimension-tiles.mjs` (`tiles-race`), and the
worktree-isolated worker pattern used by twins.

Also unbuilt: fetching a real commons over the network, and the UI surface for either half.
