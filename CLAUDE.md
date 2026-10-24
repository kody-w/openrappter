# CLAUDE.md

OpenRappter is a native Mac app: a creature that lives in the notch, thinks with a pinned Brainstem kernel, and is driven
by three hold-keys. Everything that ships is under `app/`. The old TypeScript/Python framework (v1) is retired by
aliasing: its files still exist, its tag is `legacy-v1`, and `docs/v1/README-v1.md` says where things went. Do not
build on v1 and do not delete it.

## Where things are

- `app/Sources/OpenRappter/main.swift` — the whole app: `Coordinator` (notch, mind, hotkeys, needs, menu, env proofs).
- `app/Sources/OpenRappterCore/` — `Creature` (postures, views), `Setup` (the four powers), `Mind` (kernel client and
  runner), `Ears`/`Voice`/`Hands`, `Needs` (cards from `~/.openrappter/needs/`), `ClaudeCodeHook`.
- `app/kernel/` — the pinned grail kernel (`kernel.json` SHA) and `run.sh`. Never run the grail's own installer here.
- `app/hooks/openrappter-hook.sh` — the Claude Code hook that turns permission prompts into cards.
- `app/scripts/build-app.sh` — signed universal `.app` and DMG. Release: tag `vX.Y.Z-app` → `release-app.yml`.
- `index.html` — the site (GitHub Pages serves the repo root). `docs/launch/` — Product Hunt kit. `docs/evidence/` — proofs.

## Working rules

- `cd app && swift test` must stay green. Add a test for every piece of pure logic.
- Proofs run from the environment, never from a microphone: `OPENRAPPTER_SAY`, `OPENRAPPTER_DICTATE`,
  `OPENRAPPTER_SCREEN_ASK`, `OPENRAPPTER_SIGNIN=1`, `OPENRAPPTER_SETUP=1`, `OPENRAPPTER_SETUP_FAKE`, `OPENRAPPTER_DEMO_EXIT=1`,
  `OPENRAPPTER_EVIDENCE=<log>`. Attach to a running kernel with `OPENRAPPTER_MIND=http://127.0.0.1:<port>`.
- On Kody's Mac, evidence runs attach to :7181, never :7071.
- Plain words on every screen. No "AI", no jargon, one primary button per card.
- "Done" means committed, pushed, released or live, and exercised with observed evidence.
