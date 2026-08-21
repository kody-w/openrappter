# Managing tiles: pick one up, put it down

This is the interaction guide for rappid tiles in the Frontier. It is deliberately small, because the
whole point is that there is almost nothing to learn.

## Why the tile exists

A tile binds two things that are useless apart: **the transcript** — the history, the situation, what
was being worked on — and **the exact agents that were hot-loaded for it**. That pairing is the
whole idea. A conversation without its capabilities is a log; capabilities without their conversation
are a toolbox with no job.

Everything else follows from keeping those two together in one inert object:

- **A tile is data, not a process.** A static transcript plus an agent payload. Nothing is running
  inside it, nothing is serialised mid-flight, nothing has to be paused or resumed.
- **Moving it is therefore trivial** — and moving it is the interface. Drop it on the chat and the
  existing hot-load mechanism composes its agents and its history back into the one live window;
  drag it out and the window is free again.
- **So the machinery is already built.** No session manager, no process pool, no snapshotting: the
  Brainstem hot-loads agents, and transcripts are just text. The tile is what makes those two
  facts add up to fleet management.

That is why the noun matters. A tile is the smallest thing that can hold a working situation and
still be picked up.

## The principle

**People already know how to move a physical tile.** You pick it up, you put it somewhere, and where
you put it is what happens. Agent management piggybacks on that: no menu to find, no button to
discover, no vocabulary to memorise. If a person can move a coaster across a table, they can manage
a fleet of agents.

That is an accessibility position, not a decoration: the cheapest interface to teach is the one the
body already knows. It scales because nothing new has to be explained as the number of tiles grows.

## The four surfaces

| Surface | What it is | State of tiles on it |
|---|---|---|
| **The Brainstem chat** | the big window — **this is a tile too**, the primary one: the companion currently loaded | active, running |
| **The herd** (default view) | the grid — every tile you have parked, at rest | parked, ready |
| **The arena** | a separate view where the tiles you put there compete on a task | competing |
| **The flock** | a separate view where tiles float together in a space, arranged as a working group rather than a grid | working together |
| **The binder** | the tile keeper — where tiles you are not using are stored and organised in bunches, like a binder of pages | dormant, stored |

**These are four separate places, not four renderings of one list.** A tile is in exactly one of
them, and moving it between them is a move. In particular:

- **The herd is the grid.** It is the default view and it stays what it is: your tiles, laid out in
  a grid, at rest. It is not a mode of the arena and the arena's arrangements do not apply to it.
- **The arena is its own view for its own use case** — agents competing on a task. A tile only
  competes because you put it there. Its arrangements (Ring, Rows, Focus, Grid, Stack, Custom)
  belong to the arena alone.
- **The flock is its own view too**, for when tiles are working together rather than parked. The
  herd is a grid because a grid is what you want for *finding* something; the flock is a space
  because that is what you want for *seeing a group at once* — who is near whom, what is grouped
  with what. It is the right word precisely where the herd's word would be wrong: a herd is
  something you tend, a flock moves together, and the difference matters when the tiles in it are
  actually coordinating.
- **The binder is storage**: nothing in it is running.

## Surfaces are yours to arrange, and to keep

The arena already accepts a custom layout from a local JSON file — seat positions, tile size,
surface colour, how tiles arrange, when they face down. That machinery generalises, and it should:
**a surface is a preset, and a person can make their own.**

- **Any surface can be customised**, not only the arena. The flock in particular is meaningless
  without it, because how a group is laid out *is* the information.
- **A preset is a file.** It can be exported, kept, edited by hand, and imported again — a local
  backup a person holds, in the same shape as everything else here: nothing syncs, and nothing is
  trapped ([`ONE-TIME-SEALS.md`](ONE-TIME-SEALS.md)).
- **Validation is not optional.** A preset arrives as data from outside the app, so it is checked
  before it is applied and refused with a reason if it is malformed — the same posture the arena's
  loader already takes.
- **The defaults stay.** Herd and arena ship as they are; a custom preset is something added, never
  something that replaces the surface a new person sees.

## Why you would move a tile at all

**Only the primary tile is running in the companion Brainstem.** It loads one companion, and
conversation tiles and single-agent tiles sit dormant — no worker, no port, no cost. A hatched
rapplication twin is the exception: it runs in its own isolated loopback worker and appears in the
herd as a live tile. That is the point of moving tiles rather than loading
agents: a person can keep many capabilities without paying for all of them being live, and reach
for one by dragging it in.

**The drag is the load.** A tile carries its agents, so dropping it on the chat composes those
agents into the Brainstem worker and dropping it back out takes them away again. Hot-loading stops
being an operation a person performs on a system and becomes a place they put a thing.

So tiles are kept in **bunches** — small groups a person makes for their own reasons: the ones for
this customer, the ones for this week, the ones that are competing on a task. A bunch is made the
same way everything else happens here: drag one tile onto another and they bunch; drag a tile out
and it leaves. Bunches live on any surface, and the binder is where the ones you are not using
right now are kept.

Nothing about a bunch changes what a tile *is*. It is organisation, and organisation is free:
grouping never starts a worker, never touches a conversation, and never changes which tile is
primary.

## What a tile can hold — including a rapplication

A tile holds a working situation. There is only one kind of tile; what differs is the payload it
carries:

| A tile can be | Payload | What "make it primary" does |
|---|---|---|
| a **conversation** | a transcript plus the agents that were hot-loaded for it | composes those agents and restores the history |
| a **rapplication** | a RAPP/1 `.egg` — its agents, and its own UI if it has one | hatches it and puts it in the primary window, its UI included |
| a **single agent** | one `agent.py` | composes that agent |

**A rapplication is just another tile.** It is not a second concept with its own herd, its own
buttons or its own rules: it is dragged, dropped, bunched, binder-kept and made primary exactly like
any other tile, and the same invariants hold — nothing is lost, only the primary runs, no gesture
needs a button. The protocol already says this: `rapp-tile/1.0` payloads are `agent.py` or `.egg`,
and a rapplication is simply a tile whose primary payload is an egg.

This is the whole reason to have one noun. A person should not have to learn that conversations are
managed one way and applications another; they are all things you pick up and put down.

## The gestures, and exactly what each does

### 1. Drag the Brainstem chat → herd, arena, or binder
The conversation becomes a tile on that surface, and **the Brainstem opens a fresh chat.** Nothing is
lost and nothing is asked: the thing you were talking to is now a tile you can see.

### 2. Drag a tile → the Brainstem chat
**This drop is the hot-load, and the tile self-assembles when it lands.** The runtime reads the
tile's footprint, confirms this machine can satisfy it, composes its agents into the running
Brainstem, restores its conversation, and brings up its own UI if it has one. Dropping is how a
capability gets into the primary window — there is no separate install step, no menu, no restart.
It assembles rather than hatches: nothing is consumed, an unsatisfiable footprint refuses before
anything runs, and dragging it out takes the parts apart again
([`RAPPID-TILE-PROTOCOL.md`](RAPPID-TILE-PROTOCOL.md)). What happens to what was already there depends on
whether there *was* anything:

- **The chat has a conversation → the two swap.** The incoming tile becomes primary; the outgoing
  conversation becomes a tile *in the place the incoming one came from*. A swap, exactly as it looks:
  two objects trading places.
- **The chat is blank → it just loads.** Nothing is parked, because an empty chat is not worth
  keeping. No empty tiles are ever created.

### 3. Drag a tile between herd, arena, and binder
It moves. Nothing about the conversation changes — this is organisation, not state.

### 4. Drag a tile onto another tile
They bunch. Drag one out of the bunch and it leaves. A bunch is a group a person made, nothing
more: no worker starts, no conversation changes, no tile becomes primary.

### 5. Drop a `.tile` file from the operating system onto the window
It is verified and added, the same way dropping an `agent.py` onto the Brainstem installs an agent.
The gesture is already in the product; tiles reuse it rather than inventing a second one.

## Rules that hold for every gesture

1. **Nothing is lost.** Every move preserves the conversation it carries *and* the agents it
   carries. A swap parks the outgoing side — conversation and agents together — before the incoming
   side loads.
2. **The drop target says what will happen** before the person lets go — the surface highlights and
   names the outcome ("Make primary", "Park as a tile", "Keep in the binder", "Swap with this chat"),
   using the same dashed-overlay affordance the Brainstem already uses for dropping an `agent.py`.
3. **No gesture requires a button.** There is no Park button, no Wake button in the flow. Buttons may
   exist for *destructive* or *rare* actions, never for movement.
4. **Every gesture has a keyboard path and a driver handle.** Drag is the primary gesture, not the
   only one: a person using a keyboard or assistive technology, and an AI driving the window, both
   move tiles the same way. A pointer-only design would exclude the people this is meant to include.
5. **Empty is not a state worth keeping.** No empty tile, no empty swap, no placeholder.

## The crystal

A tile also carries a **crystal**, which runs backwards from the usual progression: the newest tile
has the largest one and use wears it down, so a master's tile shows a nub. Expertise is subtractive —
you need less scaffolding, not more — and the weight drops as the crystal wears, so a well-worn tile
sits low and steady. See [`CRYSTALS.md`](CRYSTALS.md).

## Why this is core, not cosmetic

The Frontier's promise is that a person can hold several capabilities at once and move between them
without ceremony. Menus make that cost grow with the number of agents; picking things up does not.
The tile is the unit precisely because it is a thing you can move — a surface a rappid stands on, and
therefore something a hand can carry from one place to another.

## Proof obligations

A conforming implementation demonstrates, driven end to end: dropping a tile on the chat composes
its agents into the running Brainstem (they appear in `/health` and are callable in the next turn)
and dropping it back out removes them; the chat dragged to the herd becomes a tile and leaves a
fresh chat behind; a tile dragged onto a chat that has a conversation swaps the two
and loses neither; the same drag onto a blank chat loads without creating an empty tile; a tile moved
between herd, arena and binder keeps its conversation intact; and every one of those moves is also
reachable from the keyboard and from the UI driver.

## Status

**Partly built.** Exists: tiles, the herd, the arena and the binder; drag and drop between them;
the drop that hot-loads a tile's agents into the running Brainstem; swap-versus-load; bunching;
fold with undo; and keyboard and driver paths for each gesture.

Not built: the flock surface, exportable surface presets, and the crystal. The tile's footprint
(`stands_on`) is not read or enforced, so an assembly that should refuse today proceeds instead.
