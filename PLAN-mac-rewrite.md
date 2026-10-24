# OpenRappter v2: a native Mac creature (full rewrite, first principles) — 2026-10-23

## What it is for (first principles)
One creature lives on your Mac. It listens when you hold a key, thinks with the Copilot sign-in you already have,
answers out loud, and waits in the notch when it needs you. Nothing else. Everything the human and the AI say to each
other passes through one door, `POST /chat` (rapp-chat/1.0). UI is optional; the notch is the UI.

## What the rewrite deletes (52,767 lines today)
The TypeScript and Python runtimes, 20 chat channels, 8 providers, the web UI and the OpenClaw copy are a second
Brainstem kernel. They retire with a pointer (tag `v1-legacy`, status *retiring*, install URLs keep working).
v2 keeps three things: the `/chat` contract, the 3D rappter creature (rappter-vui), and the morning-decisions loop.

## Shape (three pieces, each small)
```
OpenRappter.app (Swift 6, SwiftUI, macOS 14+, no Dock icon)
 ├─ Face     DynamicNotchKit, pinned by commit. Compact: creature silhouette + state.
 │           Expanded (hover / hotkey / needs-you): reply text, decision card with option buttons, or listening waveform.
 │           Macs without a notch get the floating style for free.
 ├─ Creature The rappter (rappter-vui) hosted in a WKWebView in the expanded view; SceneKit port only if the web view
 │           is measured too slow. Five honest states: idle · listening · thinking · speaking · needs-you.
 ├─ Voice    Hold ⌥Space to talk (SFSpeechRecognizer, on-device). Replies spoken with AVSpeechSynthesizer.
 │           Senses from the reply (|||VOICE|||, |||HOLO|||) drive mouth and mood.
 ├─ Mind     A client, not a brain: GET /health, POST /chat. Attaches to a running Brainstem on :7071, or installs a
 │           pinned grail kernel (kernel.json, by SHA) as a launchd service on 127.0.0.1:18790 with the OpenRappter pack
 │           in agents/. Quitting the app never stops the work (Grok Bot's one real breakthrough, done locally).
 └─ Needs    Decision cards in the rapp-tower shape {id,title,ctx,opts[]} queue up; the creature changes posture and
             waits. Answer by button or voice. Mind down / Copilot sign-in expired shows as "hungry", never as a crash.
OpenRappter pack (expansion pack, plain agents/):  morning_brief, decisions, (phase 3) imessage.
```
Which of the three grail routes: **distro** (pinned unchanged kernel + pack) with a native face. The kernel is not touched.

## Tamagotchi rules (how the creature earns the right to be in your notch)
1. Needs are real or absent: a waiting decision, a dead sign-in, a finished job. No invented needs.
2. It never speaks first. Posture changes; sound only after you asked for that class of thing.
3. One primary action per expanded view. Details live behind "More".
4. Hungry is recoverable in one click (re-run `copilot` sign-in), and the creature shows it got fed.
5. Posture is a state; reactions are one-shot events that release (Notchling). The face never sticks in panic.
6. Feed it: drag a file, link or text onto the creature and it gulps it as context for the next `/chat` turn.
7. Asking permission has exactly three answers: allow once, no, always. A rule written as prose beats an "always".
8. Human-only steps (sign-ins, 2FA) get a "Take over" button and an "I'm done" button. Never bypassed, never faked.
9. A finished job reports in five lines: verified, assumed, done, waiting on you, open. Evidence links, not adjectives.
10. Secrets never pass through chat; the creature asks the keyring (rapp-keyring) and never sees the value.

## Phases (each ≤ 2 h, each ends with evidence, not a claim)
| # | Build | Done when I observed |
|---|-------|----------------------|
| 0 | Branch `v2`, SwiftPM app, DynamicNotchKit pinned, compact+expanded notch with placeholder | screenshot of the notch on this M4 Max, both states |
| 1 | Mind client + runner: health, chat, senses parse, attach-or-launch | curl and the app both get `response` from a live kernel |
| 2 | Voice loop: hold key → text → /chat → spoken reply; creature states driven end to end | screen recording of one round trip, transcript matches |
| 3 | Needs: tower cards in the notch, answered by button and by voice, action queued | a morning card answered from the notch, queue file shows it |
| 4 | Ship: hardened runtime, notarized DMG on `v2.0.0` tag via the existing Actions, Homebrew cask updated | fresh user account installs the DMG and completes phase 2 |
| 5 | Retire v1 by aliasing: README pointer, `v1-legacy` tag, install.sh prints "this is now OpenRappter.app" | old URLs still 200, drift check blocks new v1 edits |

Phase 3 of the pack (iMessage) comes after 5, as an agent in the pack, never in the app.

## Borrowed from Grok Bot (xAI, Aug 2026) and Notchling, what they got right
Grok Bot: named, focused teammates whose description *is* the rulebook; a runtime that outlives the app window;
local access off by default and asked each time; approvals as prose rules; secrets in a masked field; artifacts with
evidence as the unit of "done"; onboarding that auto-creates the first bot and lands a first task in ~15 minutes; no
model picker. Their pains we design around: scheduled routines that wake for nothing and burn usage (we trigger on
events), noisy multi-bot chat (one creature, silent pack agents), a shared cloud computer (ours is local, GODD stays home).
Notchling: click-through window at exact notch width, under 1 MB, idle CPU under 0.5%, body language as the interface.

## Free tuition applied
Dynamic Island (glanceable, one action), Tamagotchi (needs drive the check-in; fake needs get muted), Clippy (never
interrupt), menu-bar apps Raycast/Ice/Bartender (hotkey, login item, notarize, no Dock), Electron (native shell, not a
web app in a window), Docker `latest` (pin the fork by SHA; its README points at upstream MrKai77).

## Open call for Kody (one)
Mind = unchanged grail kernel as a distro (recommended) or keep a trimmed TypeScript mind inside the app.
