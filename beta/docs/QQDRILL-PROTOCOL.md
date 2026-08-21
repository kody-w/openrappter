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

A conforming implementation demonstrates: two drills cannot observe each other's workspace; a drill
that writes outside its workspace is prevented, not merely discouraged; the flag checker produces
the same verdict for the same artifact regardless of which drill produced it; a run stops at its
declared budget rather than exceeding it; a kill leaves nothing changed; and a run whose flag is
captured by nobody reports that honestly instead of promoting the best-looking loser.

## Status

**Specified, not implemented.** Nothing in this repository runs a drill. Related machinery that
exists: the single-contender race in `../electron/dimension-tiles.mjs` (`tiles-race`), and the
worktree-isolated worker pattern used by twins. The flag checker described in
[DIMENSION-MINING.md](DIMENSION-MINING.md) is the piece to build first — without it a drill has
nothing to collapse on, and rule 2 cannot be satisfied.
