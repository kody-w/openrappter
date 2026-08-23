# OpenRappter — Constitution (beta)

The Frontier's own law, downstream of the Brainstem `CONSTITUTION.md` and the
rapp/1 spine. Where they conflict, the kernel's law wins. Amend by PR that
changes this file in the same commit as the behavior it governs.

## Article I — The factory install

The factory install is **batteries included, and no more** — like a machine on
first boot. It contains exactly:

1. The **Grail kernel** (unmodified `brainstem.py`) and its venv.
2. The **Frontier launcher** (Electron shell, Grail chat, Rappter Surgeon, and the tile surfaces:
   the companion chat, the herd, the arena, the flock and the binder — herd and arena out of the
   box, all of them arrangeable by a preset the person can export and import).
3. **Twins**: hatch from the RAPP Store or from a local `.egg` dropped on the
   window — fail-closed `rapp/1-egg` verification, loopback-only workers,
   isolated `AGENTS_PATH` per twin.
4. **Show Mode** (click-through preview) and the Copilot Studio deploy path.

5. **The sacred three agents — the factory settings.** A newborn Brainstem
   ships with exactly three agents, for training and simplicity: `ManageMemory`,
   `ContextMemory`, and `HackerNews`. No industry agents, no capability packs,
   no Molter/Toaster — a new user learns the chat with three understandable
   tools, not a crowded catalogue.

Nothing in the factory install downloads a model, starts a media server, or
adds a background process beyond the kernel worker. First launch works with a
GitHub Copilot sign-in and nothing else.

### Just-in-time capability acquisition (the seed, not the warehouse)

Batteries included — but the batteries are a *seed*, not a warehouse. Beyond the
sacred three, the Brainstem acquires capability **just in time**, never
pre-loaded:

1. The trigger is real need: the user drops their **first** `.egg`, `agent.py`,
   or `skill.md`, or the Brainstem hits a capability it lacks (including a
   request to mutate one).
2. On that trigger it grabs exactly **one** agent from the global AIBAST repo —
   `rar_remote_agent.py`, the RAR search/acquire bootstrap — and nothing else.
3. That single seed then autonomously searches the AIBAST library and hot-loads
   the specific `agent.py` the request needs (the Molter, the Toaster, an
   industry agent — all pulled JIT through the same path, sha-verified).
4. A capability the user never needs is never fetched. The factory image stays
   the sacred three; the estate grows only along the grain of use.

Agents are **headless by default**: any hot-loaded `agent.py` is driven through
the chat — the Brainstem hand-holds the user, so a new user never has to learn a
foreign UI. A UI is summoned only when the user invokes a rapplication that
carries one; and because the Brainstem knows what an `agent.py` does (its tool
schema), a fit-for-purpose UI can be **generated on the fly** from that schema
and then molted through generations for that twin — never a pre-built UI the
user must learn.

### The one pattern

There is exactly **one mental model**, learned on day one and never added to:
`brainstem.py` + `agents/` + **drag a file into `agents/` to hot-load it**. That
is the whole interface. Everything else in the system is that same pattern,
fractally: a rapplication is a Brainstem-shaped unit — its own `agents/` holding
one or more `agent.py`s and an `index.html` at its root, mirroring the root
Brainstem's `agents/` + UI. A twin is a Brainstem — **its name is the
rapplication's name**; hatching a rapplication *is* hatching a twin. A molt is an
`agent.py`. A skill is an `agent.py` wearing a `_skill.md` coat. The recursion is
total: a rapplication could technically carry a full Grail Brainstem in its
`agents/` and behave exactly like the root — which is only ever *hatching a twin*,
not a separate feature. We do not build brainstems-in-brainstems; the point is
the **one unified vehicle**, so a user who learns the pattern once recognizes it
everywhere. The structure is
**self-organizing**: the user drops files into `agents/`; the system files
everything else along the same fractal grain. This radical simplicity — one
pattern that composes with itself — is the design constraint: fewer controls than the
alternatives, arranged so the one thing you learn is the only thing you ever need.

Corollary — **clean source, separate exhaust**: source (`agents/`, `index.html`)
and runtime output (molts, live-state, generated files) never sit in the same
pile. Source lives in the rapplication; exhaust lives on device under
`~/.rapp/<slug>/`. We do not eat where we dispose.

Corollary — **rapplications fledge**: because a rapplication folder is
self-contained (Brainstem-shaped source, exhaust kept on device), a fully-grown
capability can fly the nest. Drag the named rapplication folder onto another
Brainstem and it works on its own; or pack it as an `.egg` and re-hatch it
anywhere via drop-to-hatch — fail-closed verified, same twin, same behavior. What
you grow here travels.

### Grail compatibility — every agent must survive going home

Anything this system produces — a molt, a generated agent, a toasted skill, a
composed ring — must remain a plain `agent.py` that can be dragged back into an
unmodified Grail Brainstem without killing it. The estate is a superset of Grail,
never a fork of it.

Grail's loader wraps each agent import in an `except Exception` clause, so a
syntax error, a bad import, or a file that defines no agent is *survivable*: the
kernel logs it and keeps serving. Two things are not survivable, because
`SystemExit` is a `BaseException` and `os._exit` bypasses handlers entirely:

1. a module-level `sys.exit()` / `os._exit()` / `raise SystemExit`, and
2. a module-level hang.

The verify gate therefore refuses any candidate whose module body can terminate
the interpreter on import. A capability that cannot go home is not a capability;
it is a trap.

### Molting is isolated — the sacred Brainstem is never mutated

A capability is grown by molting, but molting happens **only inside an isolated
twin**, never by injecting a molt into the main Brainstem's `agents/`. The main
Brainstem's agents dir is sacred: the sacred three plus whatever the user
deliberately drops — nothing random, nothing generated, ever written there by a
mutation. The Molter refuses to install a molt into a sacred agents dir (one not
under `.../twins/<id>/`); a generated or molted UI likewise lives only as its own
isolated twin rapplication in the herd. Imagine random molts appearing in your
own brainstem — the isolation is the safeguard that keeps the pattern pristine.

## Article II — RAPP Organs and RAPP Senses (post-factory, opt-in)

Everything beyond Article I is an **organ** or a **sense** in rapp/1 language —
the operating system's optional device drivers:

- An **organ** is a capability pack that acts (deploy pipelines, exporters,
  builders).
- A **sense** is a perception/capture pack (screen capture, voice in/out,
  transcription).
- A **rapplication** is a shippable app (an `.egg`) that hatches as a twin.

Laws:

1. **Installed only on first enable.** Enabling a feature that needs an organ
   or sense prompts once, names what will be installed and how large it is,
   and installs to its own prefix. Never at factory install, never silently.
2. **Removable without trace.** Deleting an organ/sense restores factory
   behavior. The kernel never grows a dependency on one.
3. **Local by default.** A sense that captures (screen, mic) writes on-device
   and never transmits; capture surfaces are per-window (CDP), never whole
   desktop, so unrelated windows cannot leak into frame.
4. **The catalog follows the RAPP Store pattern** (`beta/electron/rapp-store.mjs`, schema
   `rapp-store/1.0`): one entry per organ/sense, pinned digests, install = verified fetch, same
   fail-closed posture as eggs. The catalog host is configured per distribution; no organ/sense
   catalog is published yet.

Named organs/senses as of this draft: **Showtime** (capture browser + ffmpeg +
VibeVoice narration), **Voice** (whisper server / TTS), **Film** (HyperFrames
render stack). None ship in the factory image.

## Article III — Showtime Mode

Showtime is the Frontier running a full demonstration **autonomously and on
the record**: it drives the app (hatch, herd chat, pop-out), captures its own
windows, and edits a narrated, captioned film of what happened — usable live
("watch it work") or after the fact ("what happened overnight").

1. Off by default; enabling it installs the Showtime sense (Article II).
2. Captures only Frontier windows via CDP — never the desktop.
3. The film pipeline is deterministic post-production over real captures;
   narration timing derives from the measured audio, never authored guesses.
4. A run leaves a **recap** a person can review and publish by hand
   ([`docs/RECAP-EXPORT.md`](docs/RECAP-EXPORT.md)) — never published by the run
   itself — and a failed run leaves one too.
5. Every Showtime run leaves its raw window captures beside the edited film,
   so the edit can always be audited against what actually happened.
6. Show Mode (Article I) may annotate the run in real time; Showtime is the
   recording and the edit, Show Mode is the on-screen show-and-tell.

## Article IV — Eggs and the local boundary

1. A dropped `.egg` is verified fail-closed before a byte is used; a tampered
   or unverifiable egg is refused with the law it broke.
2. Local eggs may carry internal content. They are never committed, never
   uploaded, and their on-device stores (`~/.rapp/<slug>/`) never leave the
   machine. The Frontier must never sync a twin's device store anywhere.
3. A twin's custom UI overrides the Grail chat by injection; both drive the
   same `/chat`. Chat remains the only wire into the model — deterministic
   client-side state (which tile is primary, which agents a worker composes,
   which surface is shown) is not a chat write.

## Article V — Driving applications through their UI

An AI steers an application the way a person does — through its visible
interface — via **RAPP UI Autosteer** (`rapp-ui-autosteer/1.0`,
`beta/docs/UI-AUTOSTEER-PROTOCOL.md`): scan the surface, inject declared controller
additions into a copy or frame (never the original), drive over the
AgenticDrive postMessage bus, and treat emitted events as the only evidence an
action happened. The bus mirrors the human surface exactly — steering, never a
side door around the chat wire — and the embedded app's bytes arrive only
sha-verified or inside a verified egg.

## Article VI — The command surface, and where it lives

The Frontier's own interface is drivable without the model, through the **RAPP
command-line-less CLI** (`rapp-autopilot/1.0`, `beta/docs/AUTOPILOT-CLI.md`): a
CLI interface with no command line, reached from the page console, taking a typed
string or a structured call and answering in JSON — a CLI and an API in one
surface. An AI needs two things and no more: CLI patterns, and the console on the
page. Navigation, listing and moving tiles are deterministic and free; `chat.send`
is the single crossing into the model, so intelligence is spent by decision and
never as the side effect of a button press.

That surface lives **in the client**. `index.html` is translation middleware: a new
command is composed there out of what the Brainstem already exposes, so the kernel
gains no endpoint, no field and no vocabulary — the protection Article I gives the
sacred Brainstem against mutation, extended to its interface. The Grail's own
`index.html` is never edited; additions arrive by injection into a copy or a frame,
and a client may supersede it wholesale exactly as a rapplication does. Deployments
that need different APIs ship different clients, not different kernels.

The surface drives by **performing gestures, not by producing their outcomes**: a
tile moves because a drag was made and a drop handled, at a speed a person can
follow — so an AI can demonstrate the product to someone watching, and so the
gesture's own machinery is exercised rather than bypassed.

And it is **never exclusive**. A person and an AI drive the same live window at the
same time: nothing captures focus or the pointer, nothing blocks the person's
input, each has a visible cursor, every change is attributed to whoever made it,
and any contested object goes to the person while the AI's gesture reports that it
yielded. Leases are advisory and a real keystroke reclaims them. The window belongs
to the person even while an AI is working in it.

Driver steps are **not conversation**. The narration of actions existed because
driving once went through the Brainstem in chat; deterministic driving does not,
so its steps are never appended to a transcript — the companion chat records only
what was said to or by the model. Driving is made visible instead by the interface
moving, by the console, and by the driver trace, with an optional activity view for
anyone who wants to watch it happen. Nor does it toast: a person's own action may
get brief feedback, a driver's does not, and attribution is carried **on the
object** — the tile shows whose hand moved it — never as a message over the chat.
In Show Mode narration is welcome, and it may be **spoken** by a local voice
model rather than drawn — an opt-in Sense under Article II, on-device, which
explains the work while leaving the screen to the person. The narrator is
VibeVoice: narration is not conversation, so it may lag the action, and that
slack is spent on a voice worth listening to. Chat voice is a different contract
— someone is waiting there — and it is off by default, arriving as a voice
message that plays itself while the text reply lands at full speed. Where speech
should begin at once, the two are relayed: a fast voice starts immediately while the
good one cooks in behind it, and VibeVoice takes the baton mid-utterance at a
word boundary — a seam the listener should hear as an upgrade, never a switch — so a reply starts
without waiting and improves while it is still being spoken — every word spoken
exactly once, and never a handoff into different text. All three are set out in
[`docs/VOICE.md`](docs/VOICE.md). Preferences of this kind are **one-time seals**
([`docs/ONE-TIME-SEALS.md`](docs/ONE-TIME-SEALS.md)): everything ships sealed on
the device, one action pops a seal, a popped seal never re-seals, and seals never
sync — so a new device is intuitive from nothing rather than inheriting a
configuration it did not choose.

Three tests decide compliance: **adding a command must never require a commit to
`rapp_brainstem/`**; the surface must never do what the interface cannot — no
arbitrary code, no side door, the same controls a person uses, visible while it
happens; and no gesture may lock a person out of their own window.
