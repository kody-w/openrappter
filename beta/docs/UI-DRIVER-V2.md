# UI Driver v2 — accurate, and quiet

Today's driver is measured in [`testing/UI-DRIVER-FLOW.md`](testing/UI-DRIVER-FLOW.md). The
two complaints it quantifies are the same defect seen from two sides: the model is handed
**too much of the wrong thing** (raw page text, unanchored selectors, unverified "success"),
and the user is shown **all of it** (every result echoed into the chat's agent log, the
tool schema and a 900-byte system prompt on every turn, 12 KB of page text per screenshot,
twice). Accuracy and quiet come from the same three moves: stable handles, compact diffed
outlines, and verified effects.

## Targets (measured today → v2)

| | today | v2 |
|---|---|---|
| `inspect` at rest | 4,387 B (~1.1k tok), 10/21 targets are `nth-of-type` paths | ≤ 2,000 B, 0 unanchored paths |
| `screenshot` text | ≤ 12,000 chars, sent twice | 300-char caption; full text only on request, ≤ 2,000 |
| `read` / `wait` | unbounded `innerText` | hard ceiling 4,000 / returns a handle, not text |
| per-turn overhead (Loop A) | 3,776 B schema + 919 B system context | ≤ 1,200 B total |
| post-action verification | none (sleep `settleMs`, return success) | `effect` diff + optional `until` post-condition |
| what the user sees | one bubble + a collapsed dump of every payload | one-line step tiles; payloads never rendered |

## 1. Stable addressing: handles, not paths

Every interactive control gets a **handle**: `@area.name` for singletons,
`@list[key].part` for items of dynamic lists.

- **Shell** (`beta/ui/index.html`, static markup we own): add `data-drive="shell.<name>"` to
  the 27 controls that already have ids and to the footer/menu buttons that do not.
- **Grail frame** (pristine, never edited): the frame bridge already injects attributes at
  load (`#beta-app-btn`, the logo's role). It now also stamps `data-drive` on the Grail's
  static controls by id (`#input` → `@brainstem.composer`, `#send` → `@brainstem.send`,
  `#chat` → `@brainstem.chat`, `#model-select`, the footer quick prompts by their text) and
  on dynamic chat messages by their stable `data-request-id` (`@brainstem.chat.msg[<id>]`).
- **Renderer-generated lists** (Surgeon tabs, twin tiles, store protocol records,
  dimension tiles, explorer tree rows): stamp `data-drive` with the item's
  natural key (`session id`, `twin id`, `store id`, tile id, agent filename)
  when they render. Agent Arena exposes `@herd.tile[<id>]` plus `.wake`, `.fold`,
  and `.race` actions; `@brainstem.grab` parks the active conversation, while
  `@arena.layout`, `@arena.arrange`, and `@arena.raceTarget` address its controls.
- **Fallback**: an element with no handle gets an **anchored** path — rooted at the nearest
  ancestor with an id or handle — never a 5-segment tail resolved from `document`.

`selectorFor` returns the handle first; `inspect` reports `h` (handle) instead of
`selector`; every action accepts `handle` (and still `selector`/`targetText` for
compatibility). A handle that matches zero or many elements is an error that names the
count — not a silent first-match.

## 2. Outlines, not dumps

`inspect` v2 returns an accessibility-style **outline** of interactive elements only:

```json
{ "snapshot": "o7f3…", "frame": "brainstem",
  "rows": [
    { "h": "@brainstem.composer", "role": "textbox", "name": "Message", "state": "empty" },
    { "h": "@brainstem.send", "role": "button", "name": "Send", "state": "enabled" },
    { "h": "@brainstem.chat.msg[r-41]", "role": "article", "name": "assistant", "state": "complete" }
  ] }
```

- ~30 bytes a row, ≤ 60 rows by default (the 80-element cap stays as the hard maximum).
- `state` is what the model actually needs to act: `enabled/disabled`, `checked`, `expanded`,
  `empty/filled`, `streaming/complete`, `selected`, `focused`.
- **`since: "<snapshot>"`** returns only added / removed / changed rows — the normal call
  after the first one; a re-render shows up as a diff, never as a stale click.
- `read` keeps working for genuine text needs but is capped at 4,000 chars with `tail` and
  `handle` scoping; `wait` resolves to `{ matched: true, h }` and never returns element text;
  `screenshot` returns the artifact path and a 300-char caption (the title, the active
  handle, and the last step tile), with `include_text: true` capped at 2,000.
- `route_telemetry` returns the last 20 events and a cursor.

## 3. Verified effects, fewer rounds

`click`, `type`, `press`, and `swipe` return what **changed**, computed server-side as the outline diff
before/after (≤ 5 rows) plus focus and route/URL changes:

```json
{ "ok": true, "h": "@brainstem.send",
  "effect": { "added": ["@brainstem.chat.msg[r-42]:streaming"], "changed": ["@brainstem.composer:empty"], "route": null } }
```

- **`until`** — a post-condition the server waits for inside the same round trip
  (`{ handle, state }`, `{ handle, text }`, or `{ snapshot_changed: true }`, bounded by the
  existing 120 s): one tool call instead of click + wait + read.
- `press Enter` performs the control's real submit path (form submit / associated button),
  and says so in `effect`; today's `keydown`+`keyup` with no default action is why "Enter
  did nothing" happens.
- `swipe` drives a bounded left/right primary pointer gesture against a stable handle, so
  touch-style controls can be proven without replacing their real pointer path with a click.
- Visibility now means **actionable**: `disabled`, `pointer-events: none`, and occlusion by
  `#splash` / the login overlay / `#intro` / the driver's own overlays are refusals with a
  named reason, not a silent click on the wrong thing.
- `expect` (new action) asserts `{ handle, state|text }` and returns `{ ok, actual }` —
  the regression suite's assertion primitive, usable by the model too.

## 4. Quiet: what reaches the chat

The Grail kernel echoes every tool result into `agent_logs` (`brainstem.py`, pristine) —
the Frontier cannot change that, so it makes the results small instead:

- With §2 and §3 a typical drive turn is ~1–2 KB of tool text, down from 10–60 KB. The
  collapsed "agent called BrainstemUiDriver" disclosure shrinks accordingly.
- The Brainstem-side agent's tool schema keeps one-line descriptions; the long guidance
  moves behind a `help` action the model calls once per session. `system_context` drops to
  ~250 bytes and no longer tells the model to screenshot after every click.
- The bridge renders **step tiles** in the frame — one line per action, from `effect`:
  `▶ clicked Send → reply r-42 streaming ✓` — and the Surgeon panel's `⚙ tool` row shows the
  same one-liner. Payloads are never rendered anywhere; artifacts (captures, recordings)
  render as media tiles, which the Grail path does not do today.
- A per-turn **byte budget** (default 6 KB) on the driver: when a result would exceed it the
  server truncates with `…(+N bytes — read handle:@x)`; the model is told how to get more
  rather than getting everything.
- Driver narration labels clear their text after fading (today the last label stays in the
  page text forever), and `wait` ignores the user's own prompt text when matching.

## 5. Determinism hooks (shared with the regression harness)

- `snapshot` ids are content hashes of the outline with volatile fields masked — equality is
  an assertion.
- Every command appends `{ action, handle, effect, snapshot_before, snapshot_after }` to a
  per-run **trace** (JSONL) the harness diffs against goldens.
- Surgeon and Python-agent commands share **one** queue per frame (today only the Surgeon's
  are queued, so two cursors can fight over a page).

## 6. Compatibility and rollout

- All existing actions and fields keep working; `selector` / `targetText` remain accepted.
  New fields (`handle`, `since`, `until`, `expect`, caps) are additive; the caps change
  defaults, and a scenario that needs the old volume passes the limit explicitly.
- `FEATURE-MATRIX.md` §2 (the action catalog) is the contract; each change above is a row
  with a test in `beta/tests/ui-driver-server.test.mjs` that **spins up the real server**
  against a fixture page (today that file only greps the source).
- Order: handles + outline + caps (most of the quiet, no behavior risk) → effects + `until` +
  `expect` (accuracy) → step tiles and media tiles (UX) → shared queue and byte budget.
