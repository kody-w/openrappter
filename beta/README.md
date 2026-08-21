# RAPP Brainstem Frontier

See [`GOLDEN_PATH.md`](GOLDEN_PATH.md) for the guiding product path:
learn AI, teach it back immediately as a working capability, and keep that
portable skill for life.

**Documentation index: [`docs/README.md`](docs/README.md)** — every Frontier document, grouped by
the question it answers.

This opt-in Frontier experience applies the launcher architecture used by Skill Recorder to
RAPP Brainstem:

- chat remains the universal control surface for people and other AIs;
- Frontier composes global and routed single-file agents into an isolated
  worker `AGENTS_PATH`, then invokes them through the unchanged `/chat`;
- the included `BrainstemUiDriver` agent can operate the actual visible
  frontend with an animated cursor, clicks, typing, narration, and waits so the
  user can watch or follow along;
- an Electron desktop window owns the local UI;
- the GitHub Copilot CLI is bundled through `@github/copilot-sdk` and connected
  over stdio with a bounded startup timeout;
- the launcher starts unchanged Brainstem workers on loopback ports with
  content-addressed, hardlinked agent compositions;
- app shutdown disposes the bundled Copilot client and every worker it owns.

Frontier and the regular installer use the same global runtime:

```text
~/.brainstem/
|- src/rapp_brainstem/   shared server, agents, soul, auth, and memories
|- venv/                 shared Python environment
`- beta-launcher/
   |- ambient/           fresh device + ledger context read by ContextMemory
   |- ledger.sqlite      private, queryable turn/agent/tool history (WAL)
   |- ledger.jsonl       grep-friendly mirror of the same redacted events
   |- routing/           RAPPID, stack, egg, object, and composition state
   |- recordings/        captured teaching demos
   `- src/               Frontier-only Electron, Copilot CLI, and launcher source
```

The regular installer may keep serving `http://localhost:7071`. Frontier uses
isolated loopback workers and embeds their unchanged Brainstem UI between a
live Explorer and GitHub Copilot Brain Surgeon.

## Data sloshing

Frontier keeps a private real-time ledger of completed Brainstem, twin, and
Brain Surgeon turns, tool calls, installs, hatches, molts, removals, lineage
changes, and source locations. It is ordinary SQLite plus a JSONL mirror, so
people and agents can use `select *` or `grep` with standard SQLite/shell tools.
Every write uses the same credential-redaction transform as worker logs.

The **My location and ambient context** panel controls a small
`ambient-context/1.0` device provider. A coordinate-backed user setting wins;
otherwise Frontier asks `navigator.geolocation`. On macOS, Electron location
normally remains `source: "unavailable"` without a platform location-provider
key. An IP-based city estimate is available only after explicit opt-in, is
labelled `ip-approximate`, and is off by default. City mode removes precise
labels and coarsens coordinates; `RAPP_AMBIENT_DEVICE=0` disables the device
provider.

ContextMemory ring 2 reads only the fresh `ambient/*.json` files and adds
bounded `<device_context>` and `<ledger>` layers through the existing
`system_context()` hook. The Grail kernel and `/chat` wire remain unchanged;
`RAPP_MOLT_LINEAGE=0` still composes pure Grail. Run the isolated real-worker
proof with `node beta/scripts/data-sloshing-proof.mjs`.

## The Frontier boundary

Everything the Frontier owns lives under `beta/`, and the mainline library never links to it — the
rule, the reasons and how something graduates are in [`FRONTIER-BOUNDARY.md`](FRONTIER-BOUNDARY.md),
and `tests/frontier-boundary.test.mjs` fails if a link crosses.

## What it is for

Use Frontier as a builder-operated rapid proof harness for the customer
question: **"Can AI do this?"**

It is also the teaching path: learn the AI pattern on real work, have Copilot
turn that learning into an agent immediately, inspect and test it visibly, and
keep the resulting skill as a portable RAPP capability.

It is best when the use case is still a transcript, problem statement,
screenshot, sample document, or expected outcome. GitHub Copilot builds and
repairs the code; Brainstem is the visible test UI where you hot-load agents,
inspect tool calls, validate memory, and prove the behavior. A successful proof
produces portable single-file agents, evidence, known production gaps, and a
clear recommendation for Scout, Copilot Studio, Foundry, custom code, or no-go.

Do not position the local prototype as production. Use synthetic or approved
data, validate with a human, and move real identity, connectors, governance,
telemetry, and scale into the selected production platform.

The launcher shows this guidance on first run and keeps it available through
the **What is this?** button.

The product direction is to take the user out of repetitive execution without
taking them out of understanding: the user drives by chatting, the Brainstem
delegates to agents, and visible UI actions show exactly what is being done.

## Brain Surgeon: GitHub Copilot without requiring VS Code

Frontier ports the proven vBrainstem Brain Surgeon pattern into the desktop
client. Open the **GitHub Copilot** tab on the right edge to reveal the full
Copilot coding-agent loop side-by-side with the live Brainstem.

This is not a second Brainstem or a simplified chatbot. It is GitHub Copilot
Agent mode with its normal file, shell, search, edit, and test loop. Frontier
adds RAPP-specific tools so that loop can:

- visibly type into the same Brainstem composer a person uses;
- submit through the same `/chat` and `/chat/stream` contract;
- inspect the same replies and `agent_logs`;
- author a single-file agent and compose it into exactly one isolated chat worker;
- remove that temporary source and bytecode when the request closes;
- operate the visible interface with an animated cursor;
- attach screenshots and recorded WebM demonstrations.

The nontechnical golden path is therefore one window: tell the Brain Surgeon
what outcome you need, watch it build or route the capability, and see the
Brainstem execute it. VS Code and GitHub CLI remain available for experts, but
they are no longer prerequisites for using GitHub Copilot as the Brainstem's
builder.

Chat defaults to the familiar **Messages** look in the Brainstem, Brain Surgeon,
and twin tiles: blue/gray grouped bubbles, tails, and pill composers. Choose
**Chat Look → Business** from the Frontier three-dot or native View menu to
restore the original styling; the choice is saved in `settings.json`, with
`RAPP_CHAT_LOOK=messages|business` as an override. The look is theming only and
does not change reply delivery.

The herd has two presentation modes. **Herd mode** is the default and is
identical to Frontier without the optional tile presentation. **Agent Arena**
is where parked conversations compete side by side. Select the checkable
**Agent Arena** item from the native View or three-dot menu, send the exact chat
control `agent arena`, or set `RAPP_VIEW_MODE=arena`; send `herd` or clear the
menu item to return. `RAPP_VIEW_MODE=herd` and unknown values select the safe
herd default. Park, wake, race, fold, and arrange saved dimension tiles without
changing the Brainstem kernel; persisted tiles remain local. See
[`docs/DIMENSION-TILES.md`](docs/DIMENSION-TILES.md).

Delivery independently defaults to `RAPP_CHAT_STREAM=smooth`; use `raw` for the
untouched kernel stream or `hold` for buffered delivery
(`RAPP_CHAT_TYPING=1` remains a hold alias).
Smooth mode holds the kernel's SSE wire until the terminal event while Frontier
renders the same source in a safely sanitized provisional assistant bubble at an
adaptive, word-granular frame cadence. It then hands off once to the kernel's
stable final bubble, avoiding the kernel's unresolved-Markdown render gate while
keeping the reply tail above the exactly measured composer unless the user
scrolls away. See [`docs/CHAT-STREAMING.md`](docs/CHAT-STREAMING.md).

If the user gets stuck, another AI can visibly take over the same Brain Surgeon
or Brainstem chat, perform the next steps in Frontier, show the evidence,
and hand control back without losing context.

External AIs and CLIs can enter the same visible loop:

```bash
brainstem-surgeon "Build and test the capability I need"
brainstem-walkthrough
```

That command opens the right-hand panel if needed, visibly types the task into
GitHub Copilot, and waits for its answer. The recursive control path is:

```text
external AI / CLI
  -> visible Brain Surgeon chat
  -> full GitHub Copilot coding-agent loop
  -> visible Brainstem chat (/chat)
  -> one-turn routed composition and result
```

`brainstem-walkthrough` runs the complete autonomous five-minute teaching path:
it opens the Explorer, guides Brain Surgeon through identity and stack
orientation, records the shell, hotloads a one-turn teaching agent through the
center Brainstem chat, verifies cleanup, checks GitHub updates, captures the
evidence, and reports the saved WebM and screenshot. Every run is fully decoded,
sampled at five points, and added to
`~/.brainstem/beta-launcher/walkthroughs/index.html`, including failed and
historical recordings, so improvements can be watched in order.

To decode and add recordings created before this evidence index existed:

```bash
npm run walkthrough:ingest
```

## Show Mode — describe it, or show it

Some customers can describe their process; some would rather show it. **Show
Mode** (Frontier-tagged) turns a live recording, a video, a set of screenshots,
or a transcript into a single-file agent you hotload and **test in your own
Brainstem first**, then promote into Copilot Studio, Scout, Cowork, Foundry, or
custom Azure code — the tested bytes are the bytes that ship.

Open it from the **Show Mode: click-through preview** pill in the Brain Surgeon,
from the first-run intro tile, or as a shareable page at `/beta/show-mode.html`.
The step-by-step walkthrough with screenshots is in
[`docs/show-mode/`](docs/show-mode/README.md).

An AI can drive the whole loop for a user through chat and let them watch. Ask
the Brain Surgeon (or the center Brainstem) to "use AI force mode" to operate the
Brainstem for you, or to `show_mode_click_through` — while it drives, the window
edges glow and a tag reads *AI force mode · an AI is driving this Brainstem —
you're watching*, so it is always clear an AI, not a hand, is at the controls.
`npm run show-mode:capture` walks the preview and saves one screenshot per step
(add `-- --force` to light force mode for a live demo).

## Install

The dedicated GitHub Pages installer is published at `/beta/`. It resolves the
latest `brainstem-beta-v*` release from the fork serving the page, so staging
and production remain separate.

### Windows 11

Run this in PowerShell:

```powershell
irm https://microsoft.github.io/aibast-agents-library/beta/frontier.ps1 | iex
```

### macOS or Linux

```bash
curl -fsSL https://microsoft.github.io/aibast-agents-library/beta/frontier.sh | bash
```

The same one-liner is used every time: first install, update, repair, and launch.
The bootstrap resolves the latest published Frontier release to its immutable
40-character commit before running the platform installer.

After the first install, launch **RAPP Brainstem Frontier** from Applications,
Launchpad, the Linux app menu, the Windows Desktop/Start Menu, or run:

```bash
brainstem-frontier
```

## Check for updates

Open the three-dot **RAPP Brainstem Frontier** dropdown in the Brainstem toolbar and
choose **Check for updates**. The native application menu also exposes
**Check for Updates...**. The launcher reads the version the configured GitHub
branch (`main` by default) is on, then resolves that version's **annotated
release tag** (`brainstem-beta-v<version>`, see [RELEASING.md](RELEASING.md)).
Only the tag's commit is ever offered: a commit merged after the tag carries
the same version but was never released, and a build already sitting on the
released commit is up to date however far the branch has moved. A version that
is staged on the branch but not yet tagged shows as "staged, not released".

When an update is available, **Update and Restart** runs the Frontier installer
pinned to that exact commit. Before anything moves, the updater stages a
rollback — the installed commit's own installer — and if the update fails after
it started, it re-installs the previous version and the reopened app says so.
Tracked local changes in the Frontier checkout block the update instead of being
discarded.

## Drive Frontier through chat

The source checkout includes `scripts/brainstem_ui_driver_agent.py`. The
`drive:e2e` harness sends that source through the visible GitHub Copilot Brain
Surgeon chat. Brain Surgeon supplies it to `delegate_to_brainstem` as a one-turn
ephemeral agent, and `BetaRouteManager` materializes it beside the selected
RAPPID stack without changing the shared Brainstem kernel. The agent does not
expose arbitrary JavaScript; it uses a token-authenticated loopback bridge with
bounded actions such as inspect, click, type, press, wait, read, and screenshot.

Run the update-control E2E demonstration while Frontier is open:

```bash
npm run drive:e2e
```

The harness visibly asks Brain Surgeon to hot-load the driver, type its
instruction into the Brainstem chat, send it through `/chat`, and watch the
agent animate the real dropdown. The temporary routed worker records the
window, attaches the playable WebM plus a final screenshot to chat, then is
stopped and removed in a guaranteed cleanup path.

For any workflow, the agent can use the same three-stage pattern:

1. `start_recording`
2. `run` the visible clicks, typing, waits, and reads
3. `stop_recording`

The recording is saved under `~/.brainstem/beta-launcher/recordings/` and shown
with playback controls in the agent activity attached to the chat response.

## Download boundary

The global runtime clone uses a shallow partial sparse checkout restricted to
`rapp_brainstem/`. Frontier uses a second shallow partial sparse checkout
restricted to `beta/` plus the small `tools/rapp1` conformance fixture needed
by its release tests. Neither checkout downloads `solutions/`.

Both installers default to:

```text
https://github.com/microsoft/aibast-agents-library.git
```

The `BRAINSTEM_BETA_REPO_URL` and `BRAINSTEM_BETA_REF` environment variables
exist only for fork staging and release-candidate verification.

Release procedure and source-only publication rules are documented in
[`RELEASING.md`](RELEASING.md).

## Frontier limitations

- This is an unsigned source-built Frontier preview, not an officially supported Microsoft
  desktop application. Managed-device controls may block Electron or downloaded
  source.
- Initial source installation still needs network access and may open a console
  while dependencies are assembled. Normal chat launch uses the desktop app and
  does not require a terminal.
- Brainstem's in-app GitHub device-code flow remains the authentication fallback.
  The launcher never stores GitHub or Copilot tokens itself.

## Uninstall the launcher

Removing Frontier does not remove the shared Brainstem or user data.

```bash
rm -rf ~/.brainstem/beta-launcher
rm -f ~/.local/bin/brainstem-frontier ~/.local/bin/brainstem-beta
rm -rf "$HOME/Applications/RAPP Brainstem Frontier.app"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/rapp-brainstem-frontier.desktop"
```

On Windows, remove the two **RAPP Brainstem Frontier** shortcuts and delete:

```text
%USERPROFILE%\.brainstem\beta-launcher
```
