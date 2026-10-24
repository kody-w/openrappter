<div align="center">

# OpenRappter

### A creature that lives in your Mac's notch. Hold a key and talk.

It thinks through the GitHub Copilot sign-in you already have. No new API keys, no new accounts, no new monthly bill. What you say stays on your Mac.

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-3b82f6.svg)](https://github.com/kody-w/openrappter/releases)

**[Download for Mac](https://github.com/kody-w/openrappter/releases/latest)** · [Website](https://kody-w.github.io/openrappter/) · [How it works](#how-it-works) · [v1 (the gateway)](#v1)

<img src="docs/evidence/v2-phase1/speaking.png" width="560" alt="OpenRappter answering in the notch">

</div>

## What it does

| Hold | It |
|---|---|
| **⌥ Space** | listens, thinks, answers out loud |
| **⌃⌥ Space** | types what you said into whatever app you are in |
| **⇧⌥ Space** | reads the window in front of you and answers about it |

When something needs you, the creature changes posture and waits in the notch. Claude Code's permission prompts can show there too, with **Allow once · No · Always** buttons, so you answer from the notch instead of hunting for the terminal.

No needs are invented. It never speaks first. One action per card.

## Install

1. Download the `.dmg` from [Releases](https://github.com/kody-w/openrappter/releases/latest), drag **OpenRappter** to Applications, launch it.
2. Hold **⌥ Space** and talk. The first time, allow the microphone and speech recognition.
3. The first time it needs to think, it sets up its mind (about a minute) and asks you to sign in with GitHub once.

Or: `brew tap kody-w/tap && brew trust kody-w/tap && brew install --cask openrappter`

Signed with Apple Developer ID and notarized. macOS 14 or later, Apple Silicon and Intel.

## How it works

OpenRappter is a thin native face over an unchanged [RAPP Brainstem](https://github.com/kody-w/rapp-installer) kernel, pinned by commit in [`app/kernel/kernel.json`](app/kernel/kernel.json). The app only ever talks to it through `GET /health` and `POST /chat`. If you already run a Brainstem on `:7071`, OpenRappter uses it. Otherwise it runs its own copy as a login service on `127.0.0.1:18790`, in `~/.openrappter/kernel`, and that kernel keeps working after you quit the app.

- **Speech** is recognised on the device (Apple's on-device recognizer) and spoken with the system voice.
- **Typing for you** needs Accessibility; **reading your screen** needs Screen Recording. Both are asked once, both are off until you say yes.
- **Needs** are JSON files in `~/.openrappter/needs/`. Anything can drop one: the included Claude Code hook, a cron job, a script. Answers land next to them as `<id>.answer.json`.
- **Nothing phones home.** The only network calls are from the kernel to GitHub Copilot with your own sign-in.

### Connect Claude Code

Menu bar → **Connect Claude Code**. It adds one hook to `~/.claude/settings.json`. Permission prompts, idle waits and finished turns then show in the notch. Unanswered cards fall back to the normal terminal prompt after 55 seconds.

### Build it yourself

```bash
cd app && swift test && VERSION=2.0.0 bash scripts/build-app.sh   # dist/OpenRappter.app, ad-hoc signed
```

## v1

OpenRappter 1.x was a TypeScript and Python agent gateway with twenty chat channels. It still works and its install URLs still resolve, but it is **retiring**: v2 keeps the `/chat` contract and the creature, and leaves channels to [Hermes Agent](https://github.com/NousResearch/hermes-agent) in front of a Brainstem. The v1 docs are in [`docs/v1/README-v1.md`](docs/v1/README-v1.md), the code at tag [`legacy-v1`](https://github.com/kody-w/openrappter/tree/legacy-v1), and the old web dashboard at [`dashboard.html`](https://kody-w.github.io/openrappter/dashboard.html).

## License

MIT.
