# Polish round 1 (2026-10-24)

A six-lens review (lifecycle, words, tests, docs, install, release; every finding refuted twice) found 34 defects.
Four fixers worked them in isolated worktrees; the merges are the `polish/*` branches.

What changed, in one line each:
- One turn at a time: a key press cancels the tail of the turn before it; nothing resets the creature mid-conversation.
- Hold to talk stays; a tap under 300 ms keeps listening on until the next tap, so Voice Control users can talk.
- A key released during the permission wait starts nothing; a failed microphone start no longer leaves a tap that crashes the next press.
- Honest cards: no command line tools → "Install"; no mind → "Try again"; hungry → "Sign in with GitHub". The code is spoken slowly and the clipboard is put back.
- Claude Code needs show even while hungry, are spoken once, keep one orange button, and are never hidden by rest.
- The kernel login service is opt-in (menu toggles it); a kernel the app started stops with the app; the cask uninstall boots the service out.
- Kernel launcher says plainly why it cannot start (tools, network, port) and leaves the reason in `~/.openrappter/kernel/logs/last-error.txt`.
- App CI fails when tests fail and builds the bundle on every PR; v1 release lanes run by hand only and never take "Latest".
- Site, README, launch kit and changelog say what the app really does (screen asks leave the Mac; first launch needs the tools and a few minutes).

- `ask-live.log` — the polished build attached to the signed-in kernel on :18790 and answered one question in two seconds.
- `ask-card.png` — the reply on the card, cropped to the panel.

Tests: `cd app && swift test` → 36 of 36.
