# OpenRappter v2: a native Mac creature (full rewrite, first principles) — 2026-10-23

## What it is for (first principles)
One creature lives on your Mac. It listens when you hold a key, thinks with the Copilot sign-in you already have,
answers out loud, and waits in the notch when it needs you. Nothing else. Everything the human and the AI say to each
other passes through one door, `POST /chat` (rapp-chat/1.0). UI is optional; the notch is the UI.

## What the rewrite deletes (52,767 lines today)
The TypeScript and Python runtimes, 20 chat channels, 8 providers, the web UI and the OpenClaw copy are a second
Brainstem kernel. They retire with a pointer (tag `legacy-v1`, status *retiring*, install URLs keep working).
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
OpenRappter pack (expansion pack, plain agents/):  morning_brief, decisions. Text/phone door = Hermes Agent in front
of /chat (habit 2026-10-23: never build a gateway); no iMessage code in the app or the pack.
```
Which of the three grail routes: **distro** (pinned unchanged kernel + pack) with a native face. The kernel is not touched.

## The creature's computer, local-first (the Grok Bot "persistent cloud computer", cloned with a real boundary)
Grok Bot gives every user one cloud computer shared by all bots, durable only under /workspace, and says "do not use
separate Bots as a security boundary". We invert the weak part and keep the strong part:
- **Mind on the host, hands in a box.** The kernel (grail, launchd) stays on the Mac and only ever answers `/chat`.
  Anything that runs a shell, a browser or a tool runs inside an Apple `container` (one lightweight VM per container,
  sub-second start, already installed here: 1.5.0 on macOS 27). One container per agent, never one shared computer.
- **Disposable box, durable workspace.** The container is thrown away after the job; the only durable thing is the
  mounted workspace folder, which is GODD on disk (`~/.openrappter/workspace/<agent>/`). "Persistent does not mean
  permanent" becomes "the box is never permanent, your folder always is".
- **Secrets never enter the box.** The keyring broker on the host signs or fetches on the agent's behalf per call;
  the container gets a result, never a key. Grok's masked field, done one level stronger.
- **Egress through the host only.** Grok's optional "route egress through this desktop" is our only path: the box
  has no network except a host proxy with a prose allowlist. Datacenter-IP blocks disappear, the Mac is the identity.
- **The computer is a file in the folder.** Like devcontainer.json: each agent folder carries what its box needs
  (image pinned by digest, mounts, allowlist). Same file runs the same box on the NAS or battlestation when the Mac
  sleeps, so the creature's computer follows you instead of living in someone's cloud.
- **Off is the default.** No box, no host access, until a prose rule or a one-time "allow once" says so.

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
| 1 | Mind client + runner: health, chat, senses parse, attach-or-launch | LANDED 2026-10-23: app + curl got `response` from the :7181 kernel; pinned kernel launched on :18790 (evidence/v2-phase1) |
| 2 | Voice loop: hold key → text → /chat → spoken reply; creature states driven end to end | LANDED 2026-10-23: on-device ears, system voice, dictation into the front app, screen read via OCR; spoken-reply round trip proven from the signed app (evidence/v2-phase2-3). Live microphone round trip: unverified until a person holds the key |
| 3 | Needs: tower cards in the notch, answered by button and by voice, action queued | LANDED 2026-10-23: needs folder + watcher, card with Allow once / No / Always / Later, Claude Code hook answers PermissionRequest from the notch (hook proven allow+deny; a real click answered a card). Voice answer: not built |
| 4 | Ship: hardened runtime, notarized DMG on `v2.0.0-app` tag via the cloned Actions lane, Homebrew cask | IN FLIGHT 2026-10-23: signed bundle + launchd service proven locally; tag pushed; fresh-account install unverified |
| 5 | Retire v1 by aliasing: README pointer, `legacy-v1` tag, install.sh prints "this is now OpenRappter.app" | LANDED 2026-10-23 (tag legacy-v1, docs/v1, dashboard.html kept); drift check not built |

Phase 0 landed 2026-10-23 (branch `v2`, evidence in docs/evidence/v2-phase0). Known, cause unverified: the compact view
rendered in 1 of 3 runs at the first capture while the expanded view rendered in 3 of 3; carry into phase 1.

Grok Bot is the kill test, not the model: what can it architecturally not do? Run local, live on the device,
tolerate delay, keep a body alive between tokens. Ours-first: real people use our creature before any comparison.

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
