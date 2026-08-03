# ORDER — the anatomy page (replaces the bones file list)

## 0. Kody's verdict on what shipped

> "it needs to not be just the raw files... it needs to be like an anatomy page...
> we need to make this real not just raw files... that is the openclaw slop pattern."

He is right and this is not a polish note. `BonesView` is honest and well-reasoned —
the refusals around `.env` and the show-missing-files rule are genuinely good and must
survive — but what it renders is **five gray sections of filenames and byte counts**.
A file browser with captions. Inventory is not anatomy.

The difference: inventory answers *what files exist*. Anatomy answers **what this
creature is, which parts are alive, and what it can do.** Files are the substance
underneath, not the presentation.

## 1. Architecture — one page, three surfaces

Do **not** build more SwiftUI panels. Build **one anatomy page served by the gateway**,
and have the dino open it in a `WKWebView`. Reasons, in priority order:

1. Brainstem parity — Kody has demanded it every single round. The same page must work
   in the menu-bar app, at `http://127.0.0.1:18790` in a browser, and in the
   `kody-w/chat` vbrainstem surface. One implementation, three surfaces.
2. Design range. This needs to look like something. SwiftUI `VStack`s will not get there.
3. It degrades. With no daemon, the page still renders from disk and says the organism
   is asleep — it does not white-screen.

Keep `BonesInspector` as the truth source and expose it over the gateway; keep the
existing `BonesWindowController` entry point and `openrappter://bones`. Native window,
web content.

## 2. The shape of it — a museum anatomy exhibit, not a list of systems

Kody's clarification, verbatim, and it is the whole design:

> "think of like the emoji where you can mouse over and see the different parts of the
> openrappter just like it was an anatomy of a real thing you were exploring at school
> or at a museum"

So this is **not** a stack of cards with system names. It is a **figure of the rappter
you can explore with the mouse** — the school biology poster, the museum placard, the
dinosaur skeleton in a display case with numbered pins and callout lines.

Build it as an **inline SVG rappter** — the dino, anatomically, in a single drawing.
Hoverable regions mapped to real body parts. Hovering a part lifts it out of the figure
(highlight, callout line, placard) and tells you what that organ **actually is in this
running organism** — its live state, right now, on this machine.

Specimen-label register, like a museum card: the anatomical name, then the plain-English
one, then what it is doing. Hover to explore, click to drill into the real files. It
should feel like something you'd lean in at — not a settings screen.

## 3. The anatomy — which body part is which system

Map the vocabulary Kody already established this session ("its blood and bones and
connective tissue = brainstem", DOG/GOD, organism, allele) onto actual dino anatomy:

| Body part | System | Truth source |
|---|---|---|
| **Skull** | Soul — who it believes it is | SOUL/IDENTITY/USER/BOOTSTRAP |
| **Brain** | the model and the backend it chose | chosen rung of the ladder, and why |
| **Spine** | Skeleton — the build it stands on | `current -> releases/<sha>`, version, sha |
| **Heart** | Pulse — what beats and when it last beat | cron jobs, next fire, daemon uptime |
| **Bloodstream** | circulation — the gateway | port, connections, requests, health checks |
| **Eyes / ears / snout** | Senses — how it perceives and speaks | Google Voice, Telegram, chat, CLI |
| **Claws / forelimbs** | Hands — what it can actually DO | agents, **named by capability not filename** |
| **Gut** | Memory — what it has kept | entries and recency, not byte counts |
| **Egg sac / cavity** | the Vault (GOD) — sealed, on-device | credentials, shown sealed, never opened |
| **Hide / scales** | the DOG layer — what it emits publicly | public surface, exhaust |

Use the parts that make the mapping *feel* right; this table is the intent, not a
spec to follow off a cliff. If the drawing reads better with a different assignment,
take it — but every part must map to something real and live.

**Vital signs across the top, as a patient chart.** This is the same patient/surgeon
frame from the UI work — the anatomy page *is* the chart. Alive or degraded, which
backend it chose and why, uptime, last heartbeat, agent count, whether it has a name.

## 3b. Make it real — the rules that separate this from slop

- **State, not inventory.** Every system reports **healthy / degraded / absent** with a
  plain-language consequence. Not `SOUL.md — 0 B`, but **"This organism has no name.
  It will sound like every other assistant until you give it one."**
- **Capabilities, not filenames.** `morning_brief_agent.js` is not the interesting fact.
  **"Morning Brief — summarises your day. Last ran: never."** Parse the agent's
  docstring/description; fall back to the filename only when there is nothing to read.
- **Live where it can be live.** Uptime, connections, chosen backend, next cron fire —
  poll the gateway. A number that moves proves the organism is alive in a way a static
  page cannot.
- **Degradation is a first-class state, not an error.** No daemon → render from disk and
  say *"asleep — bones intact, no pulse."* No Copilot → say which rung of the ladder it
  fell to. This is the local-first story; show it working.
- **The dino is the anchor.** 🦖 present on the page, and its expression/state should
  reflect the organism's actual health. It is the thing he clicked to get here.
- **Every system stays drillable to the real files.** The file list does not disappear —
  it moves *underneath* the anatomy, one level down, with Reveal-in-Finder intact.

## 3c. SECOND JOB — drag-and-drop hot-load of `agent.py`, in BOTH surfaces

Kody's second ask, verbatim:

> "also i need to be able to utilize both the openrappter chat and the openrappterbar
> to be able to drag in and hotload instantly agent.pys just like the vbrainstem and
> grail brainstem installer repo allows"

This is a **peer requirement to the anatomy page, not a footnote.** It is the single
interaction that makes the organism feel alive — you drop a file on it and it can
immediately do a new thing. The grail already does this; the screenshot of RAPP
Brainstem says *"Drag & Drop .py Agents Here"* and *"Add Agents: Drag and drop any
agent.py file directly onto this window to instantly teach me new things."*

Required in **both** surfaces:

1. **openrappter chat** — the web UI at `:18790`. Drop a `.py` (or `.js`) anywhere on
   the window.
2. **OpenRappterBar** — the native menu-bar app. Same gesture, same result.

Rules:

- **Hot-load means hot.** The agent is usable in the very next message with **no daemon
  restart**. If the registry cannot currently reload without a restart, fix the registry
  — do not redefine "hot" to mean "after you relaunch".
- **Study the grail first** and match its behaviour and vocabulary. Kody said "just like
  the vbrainstem and grail brainstem installer repo allows", so parity is the spec.
  Read how the brainstem does it before writing anything. **Do not modify the grail
  installer repo** — read it, mirror it.
- **Confirm what landed, in the organism's voice.** Not a toast saying "upload
  successful" — it should come back with what it can now do, the way the brainstem does.
- **Reject honestly.** A malformed agent, a name collision, or a file that is not an
  agent must say exactly what is wrong. Silent failure here is the worst possible
  outcome: the user believes it learned something and it did not.
- **This is arbitrary code execution by drag gesture.** That is the intended product
  behaviour and Kody wants it — but make the trust boundary explicit in the UI at the
  moment of the drop, and never auto-run an agent from a browser download path without
  the drop being a deliberate user gesture.
- **It must show up in the anatomy page immediately** — drop an agent, and a new claw
  appears under Hands. That is the two jobs proving each other.

**Acceptance:** with the daemon running, drop a real `.py` agent onto each surface in
turn; in each case ask the assistant to use that capability **in the next message** and
get the real result. Quote both exchanges verbatim. Then confirm the new agent is
present in the anatomy page without a reload of anything but the page.

## 4. Refusals that must survive from the current implementation

These are already right. Do not regress them:

- `.env` and anything credential-shaped: name and size only, **contents never read**,
  and never rendered into a page that could be screenshotted or shared. In the anatomy
  framing this becomes the Vault, shown **sealed** — which is a better presentation of
  the same refusal, not a weakening of it.
- **A missing file is never silently dropped.** "You have no SOUL.md" is the answer to
  why the assistant sounds generic, so absence has to be visible.
- Everything is read from the running organism at the moment it is asked. No mocks, no
  placeholders, no plausible-looking sample data. A mock inventory is worse than none.

## 5. Taste bar

Kody's phrase for the failure mode is **"openclaw slop"**. The bar is the design system
in `~/videos/catchup-0802/frame.md` — the editorial look you just used for the video,
which is his current visual register. Serif display type for the system names, mono for
values and paths, generous whitespace, restrained accent colour used only for state.
Not a dashboard. Not neon. Not a bootstrap card grid.

Self-contained page, no CDN dependency at runtime — it has to render with the network
off, because the entire product thesis is that it works offline.

## 6. Acceptance

1. `openrappter://bones` and the dino both open the anatomy page.
2. `http://127.0.0.1:18790/bones` renders the same page in a browser.
3. **Hovering each labelled part** reveals that organ's live state — walk every part and
   confirm none is dead, mislabelled, or showing a placeholder.
4. With the daemon **stopped**, it still renders from disk and reports "asleep" — verify
   this by actually stopping the daemon, not by reasoning about it.
5. Kill the network and confirm the page still renders.
6. `.env` contents appear nowhere in the DOM or the payload — grep the served HTML and
   the JSON to prove it.
7. An agent with a parseable description shows its capability, not its filename.
8. **Drag-drop hot-load works in both surfaces** and the agent is usable in the very next
   message — quote both exchanges. The new agent appears in the anatomy figure.
9. **Screenshot it** and look at it. If it reads as a file browser with better fonts, it
   has failed — say so rather than shipping it.

You cannot screenshot with `screencapture` on this machine (screen recording is denied —
you hit this in round 4). For the **web** page use headless Chrome or Playwright against
`:18790/bones`, which sidesteps that entirely, and actually look at the PNG.

## 7. Rules unchanged

Grail installer untouched. Brainstem ⇄ openrappter parity is the *point* of this one.
DOG/GOD boundary. No PII in public repos. Reversible changes only.

## 8. Report

What the anatomy page shows, the screenshot, what each acceptance check returned, and
flags. If you cannot make it look like something — if it still reads as slop — say that
plainly instead of shipping it and calling it done.
