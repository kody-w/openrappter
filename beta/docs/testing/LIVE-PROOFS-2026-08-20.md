# Live proofs — 2026-08-20

Evidence, not claims. Each entry is something exercised on a real artifact,
with what was observed. "Unverified" means exactly that.

## Fresh Grail, isolated HOME (the handoff's §5 recipe)

Installed `install.sh` from `main` under a throwaway `HOME`; kernel 0.6.16 on
:7098.

| Step | Observed |
|---|---|
| baseline `/health` | `agents: 4, quarantined: 0` |
| drag every Frontier agent in (+ ring-1 ContextMemory) | `/health`: **9 agents, `quarantined: []`**; `/chat` listed all nine tools |
| drop a broken `weather_agent.py` (class that is not a `BasicAgent` subclass), ask "what is 2+2?" | reply: *"2 + 2 = 4. ⚠️ Agent issue: Your `weather_agent.py` failed to load because it doesn't define a `BasicAgent` subclass — it's not available as a tool…"* — Ambient Context volunteered it unprompted |
| drop an agent with module-level `os._exit(0)`, hit `/health` | **process dead** (curl rc 52) — the exit-on-fault rule's teeth |

## Windows (the lab branch on the fork, windows-latest)

| Step | Observed |
|---|---|
| A — as checked out (`.gitattributes` pin in effect) | ring-1 LF, Grail CRLF; seed + verify + overlay OK; `node --test tests/molt-lineage-integration.test.mjs` **21/21** |
| B — forced CRLF ring-1 and CRLF Grail (an older checkout's shape) | `ring1 has CR: true`; seed + verify + overlay OK; HARD 3 green |
| C — full beta suite | **221/221** on Windows |
| final merged tree (`94436b6c`, lab `82a0daf6`) — A as checked out, B forced-CRLF ring + Grail, C full suite | **all three green on windows-latest** (after making the bridge-source tests CRLF-tolerant and the HEAD-is-a-directory fault expectation platform-neutral: Windows reports `EPERM`, POSIX `EISDIR`) |

## Control words typed into the real chat window (handoff §6.1 gap)

Branch Frontier launched against the live kernel with an isolated lineage root;
words typed into the Grail composer through `/drive`; HEAD files read from disk
after each.

| Word | Reply | On disk |
|---|---|---|
| (fresh home) | — | ring-1 ContextMemory seeded at HEAD |
| `baseline` | *Reverted to Grail baseline — your memories are intact.* | `HEAD` = ancestor (baseline), `PRIOR_HEAD` = ring-1 |
| `restore` | *Restored the latest verified molts — your memories are intact.* | `HEAD` = ring-1 |
| `environments` | *Molt Lineage environments: … context_memory_agent.py: default → ring …* | — |
| `promote default prod` | fast-forward | `HEAD.prod` = ring-1 |
| `baseline` again | reverted | default at baseline, **`HEAD.prod` unchanged** |

## Streaming delivery timelines (branch Frontier, live kernel, `/drive` sampling)

| Build | Typing bubble | Reply growth | First text | Done |
|---|---|---|---|---|
| kernel-native | yes (bounce) | **12 steps of 96–240 chars every ~0.53–1.5 s** (median ~0.76 s) | 3.6 s | — |
| hold-and-pop (built, then declined: "I want it to stream in") | yes | **1 step: the whole 1,604-char reply** | 11.8 s | 11.8 s |
| smooth v1 — paced kernel wire | pulse | **six visible growth steps** for a 1,683-character reply, including `+22`, `+431`, `+216`, `+68`, and `+600` after the initial paint, separated by 1–2 s gaps; kernel unresolved-Markdown structural gating caused the lumps | ≈ kernel | — |
| smooth v2 — Frontier provisional renderer | pulse | **27 visible growth steps for 1,658 characters** | 3.6 s | 11.7 s |
| smooth v2 on the final merged tree (`94436b6c`) | pulse | **27 growth steps for 1,638 chars** (median +59 chars per ~300 ms sample), provisional bubble rendered by the bridge, kernel bubble swapped in at the end; Messages look default | 2.6 s |

The deterministic v2 VM proof separately covers zero kernel bytes before
terminal, at least 40 monotonic provisional renders for 1,600 characters,
byte-identical replay, and a single handoff/removal.

## Chat look

| Build | Observation | Status |
|---|---|---|
| Messages look | Messages is the default across Brainstem, Brain Surgeon, and twin chats; Business remains a theming-only toggle. | Captured |

## Unverified

- `frontier.ps1`'s token/`git ls-remote` fallback (no PowerShell on the proving
  machine; `frontier.sh` verified in all three modes).
- The Electron composition overlay / atomic swap / kill switch driven through
  the UI (unit- and integration-tested; the regression harness will drive them).

## Evening — the harness, the review, the merges (head `17e38a56`)

| Step | Observed |
|---|---|
| e2e harness on CI, first runs | every scenario's composer "not visible" on macOS, Windows and xvfb alike — a never-shown window's cross-origin Brainstem frame has no viewport (rect 0×0); a developer Mac lays it out anyway. Window now shown everywhere. |
| Windows teardown | Electron descendants outlive `app.quit()` (crashpad/GPU); Windows reuses pids within seconds and a bare-pid kill took down a sibling scenario's fresh Electron (`Electron exited before the driver was ready` ×3). Teardown keeps creation stamps and terminates only what is still its own; Windows runs scenario files serially. |
| concurrent Surgeons | the lease banner's "(2)" lasts milliseconds because the bus serializes per frame; polling it passed on a Mac, failed on CI. The driver trace records every lock/unlock count: `L1 L2 L2 L2 L1 L1 U0`. |
| adversarial review (14 agents, 30 findings) | top 5 confirmed twice each with reproductions, e.g. the 20 s watchdog default truncating a delegated chat (probe: abandoned script still driving the frame beside the next command, `maxConcurrent = 2`); all 5 fixed with regression tests; 14 mediums + 6 lows fixed by Sol, verified real first; 5 lows skipped with reasons. |
| dimension tiles (Agent Arena) | herd-mode identity: composed bridge source === input source, byte for byte; renderer emits 0 tile DOM/listeners/CSS in herd mode; 7/7 e2e incl. park mid-reply → race → wake (history spliced) → fold → switch herd/arena. |
| data sloshing | real worker, real Molter gate, ring-2 verified; "what's the weather here" → `WeatherAgent(lat=47.6062, lon=-122.3321)` with no clarifying question; pin-drop wrote the location; the third reply cited the ledger row; `sqlite3` and `grep` return the rows from a clean terminal; a credential-shaped turn is `[redacted:token]` in both files; files 0600. |
| rappid tiles v2 (`kody-w/RAR` clone) | 307 legacy tiles → `cards/v2/@publisher/<agent>.py.card`, 0 seed/face mismatches; `card scan "DISMISS HUSK WIELD BINDER EFFACE MOON SHARD"` resolves the card; inline pack → copy to a clean dir → verify with sockets disabled: `valid: True`, `offline: ready`; pinned cards say `offline: needs 1 pinned payload(s)`. |
| CI | 18/18 green at `75a90707` and `c62fd925`; round on `17e38a56` (sloshing + review fixes) pending at the time of writing. |

### Unverified (evening)
- The dimension-tile swipe on a physical trackpad (synthetic pointer swipes pass the harness).
- Location via `navigator.geolocation` on macOS — reports `source: unavailable` without a platform provider key, as designed; not exercised with a key.
- RAR v2 forge workflow changes (`approve-agent*.yml` seal step) — reviewed by reading, not run; they run in RAR's CI after Kody pushes.
- The boot scenario failed once locally with a live Frontier running before the tolerance landed; the diff was not captured.
