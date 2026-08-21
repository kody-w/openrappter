# Crystals — the tile wears down as you master it

Every rappid tile carries a **crystal**. It runs backwards from how progression usually works, and
the inversion is the whole idea.

**The newest tile has the largest crystal. Use wears it down. A master's crystal is a nub.**

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
