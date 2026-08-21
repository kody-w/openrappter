# Crystals — the tile wears down as you master it

Every rappid tile carries a **crystal**. It runs backwards from how progression usually works, and
the inversion is the whole idea.

**The newest tile has the largest crystal. Use wears it down. A master's crystal is a nub.**

## Wear is disclosure, not loss

The crystal does not shrink because something was taken. It shrinks because what the tile actually
is has been uncovered — the scaffolding it no longer needs falls away, and what is left is the
thing itself.

Pindar's line is the exact shape of it: *become such as you are, having learned what that is*. Not
become something else, and not acquire something new — **become what you already were**, by
learning. That is what a worn tile is: the same tile, with the parts that were only ever
compensation ground off.

Which is why the direction has to be downward. A model where mastery is *added* says the expert
has more than the novice. This one says the expert needs less, and that the tile has been revealed
rather than upgraded.

## Why backwards

Collecting is the wrong model for expertise. Badges, levels and streaks all say the same thing — you
have accumulated — and none of them say the thing that is actually true about getting good at
something: **you need less.** Fewer prompts, fewer explanations, fewer affordances, less scaffolding
in the way. The tall crystal *is* the scaffolding, and mastery is what grinds it down.

So a worn tile reads correctly at a glance. "I have done this a thousand times" looks like a nub. "I
started this yesterday" looks like a spire. Neither is shameful; one is simply newer.

**And the weight follows the wear.** A tall crystal is top-heavy — showy, unsettled, easy to knock.
As it wears the centre of gravity drops and the tile sits low and steady. The tile becomes a
physical object that *feels* mastered, which is what makes it the person's own: their physical AI
tile, not a score on a profile.

## What actually wears it

The crystal is tied to the locally running model. It measures **assistance drawn down** — the help
this tile still needs to get work done — not time elapsed, not sessions opened, not turns taken.

**And training is training, wherever it happened.** A [drill](QQDRILL-PROTOCOL.md) that ran a
hundred candidate dimensions and fed real gradient updates back into the adapter has genuinely made
the tile need less. That wear is not a trophy for winning; it is the work that was done. So a
crystal can be worn deliberately — you can drill a fresh tile into an expert one instead of grinding
through the same hours by hand, which is most of the point of being able to drill at all.

**But the lineage records the mix.** Wear earned by a person using the tile and wear earned by
drilling against a synthetic flag are both real and are not the same thing, so a tile carries how it
was worn — used versus drilled — and can say so. A tile worn entirely by drilling and never touched
by a person is a legitimate object; it is not a battle-tested one, and nothing should let it present
as though it were. A tile left alone for a year is exactly as tall as you left it. A tile that
carried you through a hundred real pieces of work is a nub, because you stopped needing to be
carried.

That makes the indicator honest in the only way that matters: it cannot be waited out, and it tracks
the thing it claims to track.

## The crystal is a view of a real thing: the tile's own weight

The crystal is not a counter drawn on a card. It shows the state of an actual artifact the tile
carries — **a small weight, trained locally, that improves as the tile is used.**

That is what closes the loop. A tile already holds a transcript and the agents bound to it; add an
adapter over the local base model, refined on this tile's own work, and the tile stops merely
*remembering* what happened and starts *having learned* from it. The scaffolding falls away because
the tile genuinely needs less prompting to do the thing it has done a hundred times — and the
crystal, which measures assistance drawn down, wears accordingly. The indicator is honest because it
is downstream of something real.

**An adapter, not a model.** The trained artifact is small — a delta over a base model that is
already on the device, not a model in its own right. That size is what makes the rest of the system
possible: it fits inside a tile, so it can be parked, dragged, kept in a binder, exported in an
`.egg`, and summoned. A tile that carried a whole model could do none of those things.

### Holding is not running

A device that cannot run a model is still a full participant. Possession and execution are separate
concerns, and keeping them separate is what lets a thin machine take part at all:

- **The tile always accumulates the material.** What it learned from — the work, the corrections,
  the transcript — is collected locally on any device, because that costs nothing but storage.
- **Turning that into a weight needs compute, which may be elsewhere.** A laptop, a workstation, a
  machine the person walks to. The training happens where there is capacity.
- **The tile carries the resulting weight regardless of whether this device can execute it.** You
  can hold a file you cannot open yet. A phone can carry, park, export, publish and summon a
  crystal it has no hope of running.

So the weak device is not a degraded client. It participates in everything except execution, and
execution is the one part that can happen somewhere else without anyone losing anything.

**Which makes the format a hard requirement, not a detail.** The weight must be a standard,
documented adapter that ordinary runtimes can load — not a blob only this product understands. The
Golden Path promises a capability that follows a person for life; a weight that can only be run by
us is not that, it is a hostage. If someone wants to load their crystal into an entirely different
LLM stack, that has to work, and if it does not, the promise was never true.

### Every crystal is a dimension of the one it came from

A summoned crystal is a **starting crystal**. From the moment it is used it begins to diverge: your
work trains it, your corrections shape it, and what you end up holding is no longer the thing you
summoned. It is **your dimension of it**.

That is the divergence model applied to weights, and it produces a lineage rather than a copy:

- One starting crystal can be summoned by a hundred people and become a hundred dimensions, each
  worn differently because each was used differently.
- A dimension carries the lineage of what it descended from, so where it came from stays legible
  no matter how far it has travelled.
- **A dimension can itself be published as a starting crystal** for the next person — subject to the
  privacy rules above, which is precisely why "publish the capability, not the training" is the
  default rather than an afterthought.

A crystal trains into a tile, and the tile is what the next person summons.

Dimensions can also be minted deliberately and raced against a checkable goal rather than
grown one at a time — see [`DIMENSION-MINING.md`](DIMENSION-MINING.md). A mined winner still
arrives worn by exactly the training that happened inside the drill and no more — winning adds
nothing — with its lineage recording that the wear was drilled rather than used.

### The consequence that must not be discovered later

**A weight trained on your work encodes your work.** Not as a transcript that can be read, but not
safely either: adapters can and do surface their training data. So the rules for a trained weight
are stricter than for anything else a tile carries, and they are not optional:

1. **Training is local, and it is a seal.** It happens on the device, on the person's own material,
   and only after they popped that seal deliberately. Nothing trains in the background because a
   feature seemed helpful.
2. **A trained weight is private material by default.** It is not published with a tile, not
   included in an export, and not carried by a summon unless the person deliberately chose to
   include it — with the plain-language warning that it derives from their conversations.
3. **Publishing a tile publishes the capability, not the training.** By default what leaves is the
   agents, the structure and the lineage. A publisher who wants to share a trained weight is making
   a separate, explicit decision about their own data.
4. **Work material never trains a weight that leaves the device.** Anything belonging to an employer
   or a customer is exactly the material that must not end up in something published, and "it is
   only weights" is not a defence.
5. **Deleting the tile deletes the weight.** Removable without trace, like every other Sense under
   Article II — including any intermediate checkpoints.

### What still has to be answered

- **What counts as improvement.** Wear must track the tile genuinely needing less, not training
  steps taken or tokens spent, or it becomes a progress bar for effort rather than a measure of
  mastery. That definition does not exist yet and the feature cannot ship without it.
- **What happens on a base-model change.** An adapter is a delta over something specific. If the
  base changes underneath it, the crystal's meaning changes with it, and that has to be handled
  honestly rather than silently.

## Wearing in parallel, and merging back

A tile does not have to wear on one machine. The same starting crystal can be summoned onto a Mac
mini, a phone, a television and a wallet pass, and each one wears it differently — because each is
used differently. Those are separate dimensions of the same tile, worn at the same time.

They can be brought back together. Each dimension records the ancestor it diverged from, so a merge
has a common point to work from and can walk each history forward from it — the same shape as a
three-way merge, and for the same reason: you cannot merge two things without knowing what they
were before they parted.

The result is one whole tile again, carrying every parent in its lineage, which becomes the current
singleton that each device re-summons.

### Where this goes

The algorithm is fixable later. This is the shape it is being built toward, and it is worth
stating plainly rather than only in constraints.

**One tile, worn everywhere at once.** The Mac mini wears it on what you build. The television
wears it on what you watch and ask about. The wallet pass wears it on where you actually went. The
phone wears it on what you needed in the ten seconds you had. None of those contexts is visible to
any of the others, and none of them could have been simulated — they had to be lived.

**Merging is how the tile learns what no single device could teach it.** Not a synchronisation
step, not a backup: the dimensions come home and the tile that results knows things none of its
parents did, because it saw the same person from four directions. The singleton goes back out in
the morning and every device starts again from a tile better than the one it contributed.

**And it keeps going.** Wear that a person could never accumulate alone accrues across a life lived
in several places at once, so over years the crystal grinds toward a nub — not because one machine
was hammered, but because the tile was there for everything. What is left is small, specific, and
extremely good at being *yours*.

**The nub is a file.** It is not an account, a subscription, or a service that can be discontinued.
It travels, it is summonable by seven words, and it works on a machine with no network. Whatever
the person built over those years, they keep — which is the whole promise this project exists to
make good on.

### Merge deltas, not weights — the Dream Catcher rule

The hard problem above dissolves once the right thing is being merged.

**Dream Catcher Protocol** (Amendment XVI, the scaling law for parallel AI-produced content) says
it in one line: *parallel streams produce deltas, not state; deltas merge deterministically via a
composite key of frame tick and UTC timestamp; nothing is ever overwritten, only appended.* Its
reason is exactly ours — without it, scaling the fleet scales the collision rate; with it, scaling
scales throughput.

**And a tile is a frame** ([RAPPID-TILE-PROTOCOL](RAPPID-TILE-PROTOCOL.md)) — so the tiles a
dimension produces *are* its delta stream, already keyed and already mergeable. There is no separate
event log to build.

Applied here: **a dimension's real substance is its delta stream, not its adapter.** What the Mac
mini learned is an ordered, append-only record of what happened; the trained weights are a
*derivation* of that record. So:

- **Deltas merge deterministically.** Keyed by frame and timestamp, dedupable, order-stable, and
  never overwriting. Two devices that ran at the same moment produce two entries, not a conflict.
- **The adapter is re-derived from the merged stream**, not blended from two adapters. There is no
  averaging step to be lossy about.
- **A better trainer later is a re-derivation, not a migration.** The merged stream is the durable
  asset; every improvement in how weights are learned can be applied retroactively to histories
  already captured.

This is also why the design survives the pessimistic case. **If models never get good at merging
adaptations, nothing here breaks** — the delta stream is still complete, still ordered, still
merged, and still the thing a capability is rebuilt from. What would be lost is a shortcut, not the
system.

And the stream is independently useful even setting weights aside entirely: it is a faithful record
of how a capability was actually used across every device, which is what you want for replaying a
session, auditing what a tile did, teaching someone the path, or reproducing any dimension exactly
as it was.

### What merges cleanly, and what does not (the weights half)

This is the part to be honest about, because the two halves of a tile behave completely differently.

- **Transcripts and usage merge cleanly.** They are append-only records of things that happened.
  Union them, order them, done — nothing is in conflict because nothing is claiming to replace
  anything.
- **Trained weights do not.** Combining adapters is a real technique and it is lossy: two
  adaptations averaged can be worse than either, and confidently so. A merge that silently averages
  and reports success is the failure mode here.

**Today.** That is a statement about the current state of the art, not a property of the problem —
merging adaptations is an active area and it will get better. So the refusal below is a *stage*,
not a verdict, and the design has to leave the path open: record every merge attempt and its inputs
whether it succeeded or refused, so that when a better merger exists it can be run over histories
already captured rather than needing a protocol change. Do not prune a green bud.

So, for now, a weight merge must be allowed to **refuse**. If two dimensions were trained in incompatible
directions — one toward terse answers, one toward thorough ones — the honest outcomes are to keep
both as separate tiles, or to make the person choose, never to produce a blended thing that is
quietly worse than what went in and carries a crystal implying it is better.

### Reassimilation: forward from a point, both dimensions where they agree

A merge does not produce a compromise. It produces **one tile that goes forward from a chosen
point**, carrying both dimensions wherever they do not contradict what came before them.

- **Non-contradicting frames are simply both kept.** Two devices that learned different things
  learned different things; there is nothing to reconcile, and the fold contains both.
- **A contradiction is surfaced, never resolved silently.** Where two dimensions disagree about the
  same thing upstream, the merge stops and says so. Picking a winner quietly is how a person ends up
  with a tile that behaves in a way nobody chose.
- **The result goes forward from the merge point**, with every parent in its lineage, so the
  history that produced it stays walkable rather than being flattened away.

### On the ordering — what it is, honestly

The key is a **hybrid logical clock**: a logical tick paired with physical time, which is the
standard way to get an order that respects causality while staying close to wall-clock. Append-only
deltas that converge without coordination are an **operation-based CRDT**; folding them to current
state is **event sourcing**; merging from a common ancestor is a **three-way merge**.

Every one of those primitives is established and proven, which is the advantage: convergence is a
solved problem and this inherits the proofs rather than re-deriving them.

**But the primitives being known does not make the system known.** Each lives in its own pocket
solving its own local problem — CRDTs in collaborative text editors, hybrid logical clocks in
distributed databases, event sourcing in backends, adapters in machine learning, three-way merge in
version control. Gunpowder was well understood as a firework long before anyone pointed it at a
fortress; the chemistry was not the invention, the application was.

What this assembles, and what no shipped system I can point to does end to end:

- **One object that is three things at once** — the CRDT delta, the interface affordance a person
  drags, and the unit a capability travels in. Normally the merge layer hides *under* the UI; here
  the tile a person picks up is the delta itself, so docking does not trigger a merge, it **is** the
  merge.
- **Model adaptation as a fold rather than a merge.** The trained artifact is derived from the
  stream instead of being something you combine, which routes around the one part of this that is
  genuinely unsolved.
- **The whole loop closed** — summon, assemble, wear across heterogeneous devices, merge
  deterministically, re-derive, republish, re-summon — with no service anywhere in it.

Stated with the honesty it deserves: *I cannot find prior art for the assembly* is a weaker claim
than *none exists*, and the real test is whether it ships and works, not whether it is unprecedented.

### Wear does not add up

Two dimensions each worn thirty percent do not merge into a tile worn sixty percent. The crystal
measures **what the tile still needs**, which is a property of the merged weights — so wear is
**recomputed after the merge**, never summed. Treating wear as a balance to be totalled would let a
tile become a master by being used badly in two places at once.

### The public and private faces merge the same way

A dimension worn privately on a person's own device and one worn in public use are both real wear.
They merge by the same rule, and the privacy rules above still hold: what merges into a published
tile is the capability and its lineage, not the training taken from private material.

## Rules

1. **Wear is monotonic.** It only ever goes down. Nothing resets a crystal, nothing regrows one, and
   no update restores it — the same one-way property that makes a
   [one-time seal](ONE-TIME-SEALS.md) trustworthy, for the same reason.
2. **It cannot be granted, bought, transferred or set.** A crystal is worn by doing the work on this
   tile. There is no other way to move it, including for us.
3. **It is per tile, not per person.** You can be a master of one tile and brand new at another,
   which is true of people and is the useful thing to show. A tile carries its own crystal because
   the tile is the working situation.
4. **It is local and private by default.** It is derived from your own device's model use. It is not
   a rank, not a leaderboard, and not something other people can see because you published
   something — a published tile carries its lineage, never its owner's wear.
5. **A tall crystal is never a penalty.** Nothing is gated behind wear. It describes; it does not
   restrict.

## The honest risk

Any visible progression measure becomes a target if there is something to win. Two things hold that
down here, and they should stay: wear tracks work actually completed rather than raw calls made, so
grinding it is just doing the work; and it is private and local, so there is nobody to show it to.
If either of those changes — a public crystal, a leaderboard, a reward — the measure stops being
honest, and it would be better to remove it than to keep it under those conditions.

## Status

Specified, not implemented. Nothing in the tree renders or tracks a crystal, and nothing trains a
local weight. This is the conforming behaviour. Two things block shipping it: the wear metric needs
a definition precise enough to compute, and the privacy rules above need to be enforced by the code
rather than stated in a document — a trained weight that leaks is not a bug you can apologise for
afterwards.
