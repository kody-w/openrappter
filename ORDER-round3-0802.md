# ORDER — round 3 (2026-08-02)

## 0. Round 2 passed my gate-check. Do not redo it.

I re-verified everything myself, independently, before writing this:

```
$ curl -s -X POST http://127.0.0.1:18790/chat -H 'Content-Type: application/json' \
       -d '{"message":"hello"}'
{"schema":"rapp-chat/1.0","status":"success",
 "response":"Hey! Good to hear from you. What's on your mind?...", ...}

daemon   : /opt/homebrew/bin/node ~/.local/share/openrappter/current/dist/index.js --daemon
current  -> releases/73a6818        deployed sha == HEAD == 73a6818, clean, 0 unpushed
env pin  : OPENRAPPTER_AI_BACKEND absent from the live process env  (you did remove it)
plist    : argv now points at current/, not the stale checkout
```

Different session id and different wording from your run — a live model call, not a
canned reply. Both P0s are genuinely closed.

I also verified the bones window myself, via `CGWindowList` from Swift rather than your
path: `owner: ShowBones | title: 🦖  The bones | 706x640`. And `BonesInspector` reads
`NSHomeDirectory() + "/.openrappter"` — the **data** dir, not the release dir — so it
shows Kody's real AI: `morning_brief_agent.js` (5419 B) and `memory.json` (2710 B),
matching disk. Separating code from data was the right call and it held.

Good round. Now two things.

## 1. Clean up the stale app copies — KODY HAS AUTHORIZED THIS

You flagged that a `/Applications` copy is a login item that respawns and intercepts the
URL scheme. I asked Kody and he said clean them up. It is worse than you saw — there are
**two** apps and five registered bundles:

```
/Applications/OpenRappter Bar.app
/Applications/OpenRappter.app
lsregister: 5x "OpenRappter Bar" bundles registered for openrappter://
            + ~/Developer/openrappter/macos/dist/OpenRappter Bar.app
            + ~/Developer/openrappter/macos/dist/dmg-staging/OpenRappter Bar.app
```

Requirements:

- **Move, do not `rm`.** Relocate displaced bundles to `~/.openrappter-app-backup-0802/`
  so this is reversible. Kody authorized cleanup, not destruction.
- Unregister the stale bundles from LaunchServices and disable the respawning login item
  so it does not come back at next login.
- Re-register exactly **one** current build as the owner of `openrappter://`.
- Leave `~/.openrappter` **completely alone** — it is Kody's data (credentials,
  sessions, memory, agents), not code. Nothing in it is discardable.
- Also unmount the stale DMG if it is still mounted.

**Acceptance:** `lsregister -dump` shows exactly one bundle claiming `openrappter://`;
opening the scheme launches the current build; the daemon still answers the `hello`
acceptance afterwards; and `~/.openrappter/agents/`, `memory.json`, `config.json` are
byte-identical to before you started (checksum them first, verify after).

## 2. Continue `/loop until perfect` — the outstanding items

These were in the objective and never landed. In priority order:

1. **The Google Voice cron.** Kody's ask, verbatim: *"you can even have openrappter have
   its own ability to wake up on a cron and check for text messages and reply as needed
   to test out how it can run using google voice."* The watcher and `GoogleVoiceAgent`
   already exist from earlier tonight — wire them to a real schedule and prove one full
   cycle: a message arrives, the cron wakes, openrappter answers it. Local-first, free
   path, wildhavenhomesllc@gmail.com. Degrade gracefully when the browser session is
   dead — do not hang or spin.
2. **The catch-up video**, then **text it to 404-862-8786** with a short summary. This is
   how Kody catches up; it is part of the objective, not a nicety. He has asked for it
   repeatedly and it has slipped every round.

## 3. Rules unchanged

Grail RAPP brainstem installer repo untouched. Brainstem ⇄ openrappter parity.
Local-first degradation to on-device. DOG/GOD boundary — no PII in any public repo.
Do not revert other sessions' committed work.

## 4. Report format

What you did, what you verified **with the conditions attached** (build, port, config —
you got this right last round, keep doing it), and flags/surprises. If the Google Voice
browser session is dead and a human must sign in, say so and name the exact click —
do not simulate a passing cycle.
