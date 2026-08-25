# The RAPP command-line-less CLI — `rapp-autopilot/1.0`

**A CLI interface with no command line.** All the shape of a command line — verbs, arguments, flags,
text results, `help` — and none of the apparatus: no terminal, no shell, no process, no window. It
lives in the page and answers from the console, so an AI drives the product the way it already knows
how to drive tools, and a person never has to open a command line for any of it to work.

Call it Autopilot for short. It is the agent-first control surface, and it exists so that **driving
the interface never requires the model**.

> **Status.** The command surface is **implemented**: `rapp()` exists in `beta/ui/autopilot.js`,
> takes both calling shapes, carries 21 verbs of which only `chat.send` reaches the model, performs
> real drag gestures through the renderer's own drop handler, and yields a contested object to the
> person. Also built: the **activity view** (the driver step feed is a click-through strip on the
> body, off unless switched on, no longer inside the chat transcript) and **per-actor attribution**
> (a driver's change stamps the tile instead of toasting, decided by `event.isTrusted`).
>
> Still **specified and not yet built**: wiring the activity view on automatically for Show Mode
> and a Showtime run, the station ident, and everything in [`VOICE.md`](VOICE.md). Those are
> described here in the normative sense — what a conforming implementation does — not as shipped
> behaviour.

**Any AI can use it, with two prerequisites: it knows CLI patterns, and it can
reach the console on the page.** No SDK, no client library, no account, no service to register with.
From inside the page there is no credential at all. An AI that is *not* already in the page reaches
the same surface over the local driver bus, which is guarded by the install's own loopback token —
the single credential anywhere in this system, generated locally and never leaving the machine. If an AI can evaluate one expression in a frame, it can operate the whole
product — the same screens, the same controls, the same feedback a person gets.

That universality is the point. Every integration path that requires something *specific* — our
library, our transport, our credentials — excludes whatever AI does not have it. A console and a
command string are the smallest common denominator that already exists everywhere.

**And the interface is free.** The Brainstem's intelligence costs money; opening the herd, switching
to the arena, parking a tile or reading the transcript does not. Today an AI that wants those things
often asks the Brainstem in chat, spending a model call and tool rounds on a button click. Autopilot
is the deterministic half: an AI drives the interface for nothing and reaches the model only when it
actually needs intelligence.

The name is the design: *command-line-less* because there is no command line, *CLI* because the
shape is exactly what an AI already drives well and a person can read at a glance. Removing the
terminal removes the only part that was ever a prerequisite.

For bounded JSON journeys, packaged-app launch, redacted artifacts, and the
explicit-test-only `openrappter.ui.run(...)` wrapper, see
[`SEMANTIC-UI-PLANS.md`](SEMANTIC-UI-PLANS.md). It is a closed naming layer
over this same driver, not a second automation implementation.

## How it is driven

The Frontier already injects controllers into frames (`executeInFrame` in
`beta/electron/ui-driver-server.mjs`) and the UI already carries stable `data-drive` handles. Autopilot
adds one global to each driven frame:

```js
// evaluated in the frame — the console, executeJavaScript, or the driver bus
await rapp("herd.open")
await rapp("tile.park")
await rapp(`
  arena.switch
  tile.primary tile-7
  chat.read --last 1
`)
```

`rapp(script)` takes one command per line, runs them in order, stops at the first failure, and
returns a JSON result — never a rendered string to be parsed back:

```json
{ "ok": true, "ran": 3, "results": [ { "cmd": "arena.switch", "ok": true, "view": "arena" } ] }
```

It also `console.log`s a one-line summary per command, so a human watching the console sees exactly
what an AI did, in order — the same evidence trail the driver's traces already keep.

## The command surface

Nouns are the surfaces; verbs are what a person can do to them. Everything here is deterministic —
no model, and no network beyond the app's own loopback, with one named exception: making a
pinned-only tile primary fetches its pinned bytes and verifies their hashes before anything runs,
and reports `fetched: true` when it did.

| Command | Does | Costs a model call |
|---|---|---|
| `herd.open` / `arena.switch` / `binder.open` | show a surface | no |
| `herd.list` / `arena.list` / `binder.list` | the tiles on a surface, with ids | no |
| `tile.park [--to herd\|arena\|binder]` | park the current chat as a tile | no |
| `tile.primary <id>` | make a tile primary — hot-loads its agents and restores its history; an occupied chat swaps out to a tile where the incoming one came from | no |
| `tile.move <id> --to <surface>` | move a tile between surfaces | no |
| `tile.bunch <id> <id>` / `tile.unbunch <id>` | group and ungroup | no |
| `tile.fold <id>` / `tile.undo` | fold, and take it back | no |
| `chat.read [--last N]` | read the transcript | no |
| `chat.type <text>` | put text in the composer without sending | no |
| `ui.inspect [--target shell\|brainstem]` | the operable outline, capped | no |
| `ui.click <handle>` / `ui.press <key>` | the raw fallback for anything unnamed | no |
| `ui.wait <handle> [--text …]` | wait for a condition | no |
| **`chat.send <text>`** | **ask the Brainstem — the model runs** | **yes** |

That table is the point of the whole document: **one row costs money.** If a task can be expressed
with the others, it should be.

## One surface, two shapes: it is a CLI *and* an API

The same entry point takes a string or a structured call, because the difference between a CLI and an
API is a calling convention, not a system:

```js
rapp("tile.primary tile-7")                       // CLI shape — what an AI or a person types
rapp({ cmd: "tile.primary", args: { id: "tile-7" } })  // API shape — what a program calls
```

Both go through the same allowlist, the same validation and the same result envelope. Neither is a
"text mode" bolted onto the other, so a driver picks whichever shape it emits reliably — and an AI
that is good at CLIs and a program that is good at JSON are the same client to us.

## The client is the extension point — the Grail is not

This is the part worth taking seriously, because it decides where a decade of feature pressure lands.

Normally a new capability becomes a new server endpoint: somebody needs to list tiles, so `/v1/tiles`
is added to `brainstem.py`. Do that a dozen times and the kernel permanently carries the Frontier's
vocabulary — and so does every downstream that ships it.

Invert it. **`index.html` is the translation middleware.** The client already holds the state, the
DOM and the session, and it can already call what the Grail exposes; so a new command is *composed
there*, out of primitives that already exist, and the surface is defined by the client that is
loaded rather than by the server that is running. Which gives four properties:

1. **The Grail gains no endpoints.** `brainstem.py` keeps `/chat`, `/health` and the surface it
   already had. Adding a verb is a client-side composition, never a route — and never a field on an
   existing route either.
2. **The Grail's own `index.html` stays pristine.** Additions arrive by injection into a copy or a
   frame, the rule [`UI-AUTOSTEER-PROTOCOL.md`](UI-AUTOSTEER-PROTOCOL.md) already enforces.
3. **And it can be superseded outright.** A different `index.html` may replace it wholesale — which
   is exactly what a rapplication does — and the command surface travels with it. Supersession is a
   supported move, not a fork.
4. **Two needs, two clients, one Brainstem.** Deployments that want different APIs ship different
   clients. Nobody maintains a second kernel to get a different vocabulary.

**The test, and it is checkable:** *adding a command must never require a commit to
`rapp_brainstem/`.* If a proposed verb cannot be built from what the Grail already exposes, the
answer is to drive the interface (that is what autosteer is for) or to spend a `chat.send` — not to
grow the kernel. A verb that forces a kernel change is in the wrong layer, and the constitutional
boundary in the repository's `CLAUDE.md` says the same thing from the other direction: no beta
routing fields or endpoints in `brainstem.py`.

## The gesture is real — and two can drive at once

Two requirements that look like polish and are actually the architecture.

### 1. It drags. It does not shortcut to the outcome.

Tiles are moved by dragging, so `tile.move` **performs a drag**: it grabs the tile, moves along a
path, hovers the target — which highlights and names the outcome, exactly as it does for a person —
and drops. The state changes *because the drop happened*, through the same handler and the same
events a hand would produce. It never calls an internal function that produces the end state without
the gesture.

That distinction is worth being strict about, because the shortcut is always the easier
implementation and it quietly breaks three things:

- **The demonstration.** The hero use case is an AI *showing* someone how to work the product while
  they watch. A state change that teleports teaches nothing; a drag teaches the gesture.
- **The fidelity.** A verb that bypasses the drop handler stops testing the drop handler. Everything
  the gesture does on the way — the highlight, the swap decision, the hot-load — goes unexercised.
- **The law.** "Same surface a person uses" is only true if the same code runs.

So the default speed is **watchable**, not instant: a person can follow the cursor and see the
target light up. `--speed fast` and `--speed instant` exist for test runs; they change the tempo of
the gesture, never whether the gesture happens.

### 2. Two-player: the person and the AI drive the same window, at the same time

The AI's driving is a *second* set of hands on the same live interface, not a takeover of it. Both
are live simultaneously — the person can keep working while the AI works, in real time, and either
can act at any moment. Concretely:

- **Nothing is captured.** No exclusive focus, no pointer capture, no modal, no invisible overlay
  that swallows clicks. The person's input path is never intercepted while an AI gesture is running.
- **The AI has its own cursor.** Its pointer is rendered and visibly attributed, so at a glance you
  can tell which hand is moving — yours or the one you are watching.
- **The person wins every conflict.** If both reach for the same tile, the AI's gesture aborts and
  reports `yielded_to_user`. It does not wait for a gap and retry silently; yielding is a result the
  driver sees and can decide about.
- **Every gesture is interruptible.** Take the tile, press Escape, or simply start doing something
  else — nothing is atomic in a way that locks a person out of their own window mid-drag.
- **Changes are attributed.** The trace records the actor for every change, and the changed object
  itself carries it briefly at the moment it happens — never a toast and never a chat message (§3). Two hands on one window is only trustworthy if you can always
  tell whose hand did what.
- **Leases are advisory.** The chat lease claims the composer against *other automation*; a real
  keystroke from the person takes it back immediately. Today it is advisory in both
  directions: the keystroke reclaim is implemented, while the claim against other automation is
  not yet enforced — the only serialisation that exists is the driver's `activeCommandId`, which
  supersedes an older command rather than deferring to the lease holder. A lease that could lock a person out of their
  own composer would be a bug, not a feature.

This is the difference between automation that runs the product for you and an AI that works
alongside you in it. The second one is the product.

### 3. Actions are not conversation

The driver narrates its steps into an announce overlay — "▶ pressed @herd.tile[…] ✓". That
existed for a good reason: driving used to go *through* the Brainstem. An AI asked the model, in
chat, to do something; the steps were part of that exchange, so they belonged in the transcript.

Deterministic driving breaks that assumption. Navigation never reaches the model, so narrating it
as chat messages writes machine steps into the record of a conversation that did not happen. In the
large companion Brainstem chat especially, it is simply wrong: that surface is a conversation, and
these actions are not one.

So:

- **The companion chat shows conversation only.** Driver steps are never appended to the transcript.
  Nothing is written into the chat that was not said to, or by, the model.
- **Driving stays observable by better means.** The interface itself moves — that is what performing
  real gestures buys — every command is logged to the console, and every command is recorded in the
  driver trace. Those are the record. The announce overlay is not a step record: it is retired as a
  default surface and stays available only for pointing at a control while demonstrating.
- **An activity view exists for when someone wants to watch**: a separate surface, never the
  transcript. Off by default; on in Showtime and while demonstrating, where being watched is the
  entire point.
- **Toasts follow the same rule.** A confirmation floating over the companion chat — "Made
  'Which path wins?' primary." — is driving feedback wearing conversation's clothes. A *person's*
  own action may still get brief feedback, because that is ordinary interface courtesy; a
  *driver's* action does not toast, and there is no setting that turns it on.
- **Show Mode may narrate, and narration can be spoken.** Where being watched is the point, saying
  what is happening is genuinely useful — and the best channel for it is **audio**, through a local
  voice model, not more things on screen. Spoken narration explains the work while leaving the
  screen to the person, which is exactly what a second pair of hands should do. It is an opt-in
  Sense under Article II: installed on first enable, removable without trace, on-device by default,
  and never on outside a Showtime run or Show Mode. The voice is **VibeVoice**, chosen deliberately for quality over
  immediacy — narration is not conversation, so it may lag the action it describes by a moment, and
  that slack buys a voice worth listening to. A latency-bound assistant voice cannot make that
  trade; a narrator can.
- **Attribution lives on the object, not in a message.** When the AI moves a tile, the tile
  briefly carries who moved it. That satisfies "you can always tell whose hand did what" without
  narrating anything into the chat — which is the only way attribution and this rule can both be
  true at once.

This is the honest reading of "not hidden automation". What makes driving visible is that it happens
in the visible interface, not that a log is pasted into a conversation.

## Built for other AIs, not for one of them

The point of a CLI shape is that **any** AI can drive this — GitHub Copilot, another Claude, a local
model, a script — without reading this document, without a client library, and without asking the
Brainstem. That imposes requirements the surface has to meet:

**1. It describes itself in one call.** `rapp("help")` returns the whole command surface as JSON:
every verb, its arguments, its types, whether it costs a model call, and one example each. An AI
learns the interface at runtime instead of being taught it.

```json
{ "version": "rapp-autopilot/1.0",
  "commands": [
    { "cmd": "tile.primary", "args": [{"name":"id","type":"tile-id","required":true}],
      "costs_model": false, "example": "tile.primary tile-7",
      "does": "make a tile primary — hot-loads its agents and restores its history; an occupied chat swaps out to a tile where the incoming one came from" }
  ] }
```

**2. The bootstrap is one paste-able block.** Nothing to install:

```js
// read the endpoint the app publishes, then drive it
const meta = JSON.parse(fs.readFileSync(`${home}/.brainstem/beta-launcher/ui-driver.json`));
await post(meta, { action: "run", steps: [{ action: "autopilot", script: "help" }] });
```

**3. Errors teach.** An unknown verb returns the nearest valid one and the help entry for it, never
a stack trace: `unknown command "tile.make" — did you mean "tile.primary"? …`. A wrong argument says
which argument and what it accepts. An AI recovers on the next turn instead of falling back to chat.

**4. State is readable, so a driver can orient.** `herd.list`, `arena.list`, `binder.list` and
`ui.inspect` let an AI see where things are before acting, so it never has to guess a tile id or
whether a surface is open.

**5. The vocabulary matches the documentation a person reads.** The verbs are the gestures in
[`TILE-MANAGEMENT-UX.md`](TILE-MANAGEMENT-UX.md) — park, primary, move, bunch — plus fold and its
ten-second undo from [`DIMENSION-TILES.md`](DIMENSION-TILES.md). One vocabulary
for the person, the AI, and the tests.

**6. It is discoverable from inside the product.** The same `help` output is what the Rappter Surgeon
is told about at startup, so an AI already in the window knows the free path exists before it spends
a model call on a button.

## Laws

1. **No arbitrary code.** `rapp()` accepts allowlisted verbs and validated arguments only. It never
   evaluates caller-supplied JavaScript — an injected CLI that can run anything is not a CLI, it is
   a hole.
2. **Deterministic or nothing.** Every command either performs its effect and reports it, or fails
   with a reason. No command asks a model to interpret intent.
3. **Same surface a person uses, by the same gesture.** Commands drive the real controls and the
   real handles, and a gesture is performed rather than shortcut — a move is a drag, through the
   drop handler. If a person cannot do it in the interface, autopilot cannot do it either.
4. **Never exclusive.** Driving never captures focus or the pointer, never blocks the person's
   input, and always yields the contested object to them. The window stays theirs while an AI works
   in it.
5. **Bounded and observable.** Every command is capped in time and output, logged to the console,
   and recorded in the driver trace — the existing budgets and traces apply unchanged.
6. **One way in.** Autopilot is a thin naming layer over the existing driver actions; it does not
   fork a second control path or a second security model. The loopback token still guards the bus.
7. **No new Grail endpoints.** A command is composed in the client from what the Brainstem already
   exposes. Needing a kernel change is the signal that the verb belongs in another layer.
8. **The model stays reachable.** `chat.send` exists precisely so an AI can hand over when it needs
   intelligence — the point is to make that a decision, not a default.

## Why this shape

- **A console-injected CLI needs no window, no port and no client.** One evaluated expression drives
  it; that works from the driver bus, from DevTools, from an automated test, and from an AI with a
  single tool call.
- **Verbs are cheap to learn and cheap to emit.** An AI writes `tile.primary tile-7` reliably; it
  writes a DOM traversal unreliably.
- **It degrades to the raw driver.** Anything without a verb is still reachable through `ui.click`
  and friends, so the layer never becomes a ceiling.
- **The client is replaceable, so the surface is negotiable.** Because the command layer lives in
  `index.html` and not in the kernel, a deployment can extend it, trim it, or supersede it entirely
  without a fork of the Brainstem — the same property that lets a rapplication bring its own UI.
- **It assumes nothing about who is driving.** A frontier model, a small local one, a shell script or
  a person in DevTools all issue the same strings and read the same JSON. Nothing in the surface
  encodes which AI is on the other end, so nothing has to be ported when that changes.

## Proof obligations

A drag is proven by the handler it went through: `tile.move` produces the same drop-handler
invocation and the same resulting state as a hand-performed drag, and a run with the renderer's drop
handler removed **fails** — proving the verb went through the gesture rather than around it. Two-player
is proven live: while an AI gesture is in flight, a simulated person's click on another control is
delivered and acted on; and when both reach for one tile, the person's grab wins and the AI's result
is `yielded_to_user`.

Then, driven end to end, with the model provably not invoked: a navigation sequence (open the herd, switch
to the arena, park a tile, make another primary, read the transcript) completes through `rapp()`
alone, and the model-request count for the session stays at zero; `chat.send` increments it by
exactly one; a malformed or non-allowlisted command is refused without side effects; and every
command appears in the driver trace with its result.
