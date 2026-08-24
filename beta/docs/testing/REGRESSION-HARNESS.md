# Frontier regression harness — every feature, driven through the autonomous UI controls, deterministically

Companion to [`FEATURE-MATRIX.md`](FEATURE-MATRIX.md) (150 features, 19 `/drive` actions,
26 IPC channels, 25 things nobody tests) and [`UI-DRIVER-FLOW.md`](UI-DRIVER-FLOW.md) (what the
driver does today, measured). This document is the design of the suite that closes the gap.

## The bar

Every row of the matrix gets a scenario that (a) runs without a human, (b) runs without a
live model or the network, (c) drives the app the way the AI drives it — through the `/drive`
bus — and (d) fails only when behavior changed. The same suite runs locally and in CI on
macOS, Windows, and Linux.

New journeys use the closed
[`openrappter-ui-plan/1.0`](../SEMANTIC-UI-PLANS.md) action catalog. A source
regex, coordinate click, arbitrary selector, or direct IPC call cannot mark a
new visible feature covered.

## Why today's tests do not get there

- There is **no fake model**. Every script that drives the real app needs a signed-in Copilot
  and a live model (`FEATURE-MATRIX.md` §5.1). Live-model output is not deterministic.
- Most "UI" tests are **regex checks of source text** (`surgeon-multichat`, `twin-manager`,
  `installer-contract`, `show-mode-tour`, `ui-driver-server`); `renderer.js` and
  `show-mode-tour.js` have zero executed coverage.
- The app **adopts a healthy server on :7071** instead of owning one, and delete-agent writes
  into the user's real `~/.brainstem` — a test run can touch the developer's install.
- `/drive` results are raw page text with no stable handles and no post-action verification,
  so a scenario cannot assert an outcome without parsing prose (`UI-DRIVER-FLOW.md` §3).

## Architecture

```
 node --test beta/tests/e2e/**            ← one file per matrix area, node:test, no new runner
   │
   ├─ harness/launch.mjs                  ← boots the Frontier (window shown) in a throwaway root:
   │     BRAINSTEM_HOME, BRAINSTEM_BETA_HOME, RAPP_LINEAGE_HOME under mkdtemp;
   │     a COPY of rapp_brainstem/ as the Grail (never the user's);
   │     BRAINSTEM_BETA_OWN_PORT=1 → the app must own its kernel (never adopt :7071);
   │     returns { driver, paths, logs, stop() }
   ├─ harness/model-replay.mjs            ← the fake Copilot (below)
   ├─ harness/surgeon-fake.mjs            ← scripted Copilot-SDK sessions for the Surgeon
   ├─ harness/drive.mjs                   ← typed client for /v1/command: run(), expect(), trace
   └─ harness/golden/<scenario>.jsonl     ← recorded action→effect traces (UI Driver v2)
```

### 1. The fake model — a replay server, no kernel change

The Grail kernel (`rapp_brainstem/brainstem.py`, never modified) calls the Copilot API at the
endpoint it received from the token exchange and caches `{token, endpoint, expires_at}`. The
harness pre-seeds that cache with a fake token, a far-future expiry, and
`endpoint = http://127.0.0.1:<port>` — so the pristine kernel talks to our server.

`model-replay.mjs` serves `/chat/completions` (stream and non-stream) from a **cassette**:

- **Record mode** (`RAPP_MODEL_CASSETTE=record`, needs a real sign-in, run by a human once):
  proxies to the real endpoint and stores `(fingerprint → response)` where the fingerprint is
  a hash of the normalized request (system prompt, messages, tool schemas) with volatile
  fields (timestamps, request ids, memory guids, paths) masked.
- **Replay mode** (default): serves the stored response; an unknown fingerprint **fails the
  test loudly** with a diff of the nearest cassette entry — a prompt or tool-schema change is
  a behavior change and must be re-recorded deliberately.
- **Scripted mode**: a scenario can also hand the server a small script — "when asked with
  tool X available, call X with these args, then answer Y" — for concurrency scenarios where
  the exact wording does not matter but the tool sequence does.

The Surgeon is GitHub Copilot CLI over the SDK, not the kernel. `rappter-surgeon.test.mjs`
already injects a fake `runtime.createSession`; the harness promotes that into
`BRAINSTEM_BETA_SURGEON_RUNTIME=fake`, honored by `copilot-runtime.mjs`, which loads
`surgeon-fake.mjs` scripts (the same scripted shape as above). With both fakes, "two Surgeon
chats delegating to the Brainstem at the same time" is reproducible to the byte.

### 2. Isolation that cannot leak

| Concern | Knob | Enforced by |
|---|---|---|
| kernel source + agents | copy of `rapp_brainstem/` under the temp root via `BRAINSTEM_BETA_SOURCE_DIR` | `launch.mjs` asserts the configured dir is under the temp root |
| Python | `BRAINSTEM_BETA_PYTHON` (the developer's venv is fine: it is read-only for the kernel) | — |
| beta state | `BRAINSTEM_BETA_HOME` under the temp root | existing |
| lineage | `RAPP_LINEAGE_HOME` under the temp root | existing |
| ports | `BRAINSTEM_BETA_OWN_PORT=1`: `BrainstemProcess.start` must spawn, never adopt | **new**, plus a test that an occupied :7071 is ignored |
| delete-agent | writes only to the configured (copied) Grail | follows from `BRAINSTEM_BETA_SOURCE_DIR` |
| time | `RAPP_TEST_CLOCK` → `LineageStore({now})`, telemetry, file names | new knob in the few places that stamp time |
| randomness | identity, ephemeral nonces, lease tokens: fixed per scenario via `RAPP_TEST_SEED` | new knob in `mintRappid`/`randomUUID` call sites that affect assertions |
| single-instance lock | a distinct `userData` per launch | `launch.mjs` passes `--user-data-dir` |

### 3. Driving and asserting

Scenarios use the `/drive` bus through `harness/drive.mjs`, never `page.evaluate`:

```js
const app = await launch({ cassette: "hatch-json-doctor" });
const t = app.driver;
await t.run([
  { action: "click", handle: "@shell.store.open" },
  { action: "click", handle: "@store.tile[json-doctor].hatch", until: { handle: "@twin.tile[json-doctor]", state: "ready" } },
]);
await t.expect({ handle: "@twin.tile[json-doctor].status", text: "ready" });
t.trace.assertMatchesGolden("hatch-json-doctor");   // action→effect JSONL, volatile fields masked
```

Assertions are three kinds, in order of preference: **state files** (compositions, lineage
HEADs, twin dirs, telemetry JSON — exact), **outline snapshots** (`inspect` v2 returns a
stable outline with a `snapshot_id`; equality is the assertion), and **golden traces** (the
action→effect log of a whole scenario). Prose from the model is never asserted; tool calls
and effects are.

Handles (`@area.name`, `@list[key].part`) are the UI Driver v2 addressing scheme
([`../UI-DRIVER-V2.md`](../UI-DRIVER-V2.md)). Until v2 lands, scenarios address the stable
ids the matrix lists (`#surgeon-send`, `#input`, `#send`, `#agent-tree`, …) and avoid
`nth-of-type` paths.

### 4. Tiers

| Tier | What | Model | Where it runs |
|---|---|---|---|
| T0 | the existing unit/integration suites (`npm test`) | none | every push (today) |
| T1 | shown app window + replay/scripted model, every matrix row that does not need the network | fake | every push, 3 OSes (`frontier-e2e` job; Linux under `xvfb-run`) |
| T2 | network rows: store download from the real catalog, update check against the real tag, installer on a clean home | none (git/curl) | every push, already partly covered by preflight |
| T3 | live-model smoke: 5 scenarios re-recorded weekly (cassette refresh) — catches prompt drift | real | nightly / manual, never gating |

### 5. Matrix → scenarios (first 24, by area; the rest follow the matrix rows)

| Area | Scenario | Asserts |
|---|---|---|
| shell | splash → ready; explorer opens, lists the 4 factory agents, source view renders | outline, `#agent-tree` rows |
| shell | Surgeon tab: new chat, send, one `⚙ tool` row per call, reset | outline, fake session log |
| surgeon | **two Surgeon chats delegate to the Brainstem concurrently**; lease banner shows "(2)"; both replies land in their own tab; no cross-talk | lease tokens, trace, `#chat` bubbles by request id |
| surgeon | 12-session cap refuses the 13th with the documented message | outline |
| store | open picker, switch source to a loopback catalog, install an agent → route swap → tool callable | `store-source.json`, composition dir, kernel `/health` |
| store | **hatch a rapplication from the store** (json_doctor) → twin tile ready → twin `/chat` answers (scripted) | twin dir, tile state, trace |
| store | yanked entry is hidden/refused; recall reaches a running app within the TTL | outline, error text |
| eggs | drag-drop an `.egg` → hatch → worker boots | twin dir, `/health` of the worker |
| lineage | type `baseline` then `restore` in the real composer; replies; route URL changes; HEAD files | HEAD/PRIOR_HEAD, bridge reply, outline |
| lineage | `environments`, `promote default prod`, `drift prod`; CONFLICT path; corrupt journal refusal | `HEAD.prod`, `promotions.json`, replies |
| lineage | `RAPP_MOLT_LINEAGE=0`: words reply "turned off", nothing moves | HEAD files unchanged |
| ambient | drop a broken agent into the copied Grail, trigger a route restart, and prove the Frontier quarantines it before Ring-1 can scan it | `composition-quarantine`, healthy `/health`, no self-state block or UI warning |
| bridge | `/chat/stream` interception, fail-open after timeout, export redaction blob, three-dot menu phases | outline `data-phase`, downloaded blob |
| twins | 8-twin cap; close during loop; pop-out window lifecycle | twin dirs, events |
| updates | fake git: "staged not released", "available", "up to date", "re-align"; Install → runner → `update-result.json` → next launch shows success / restored / failed | `#beta-update-status[data-phase]`, result file |
| show mode | tour autostart (`?tour=show-mode`), 14 steps, keyboard, pane restore | `window.rappShowModeTour` via `tour` action |
| driver | `/v1/command` auth rejection, body limit, heartbeat, artifact expiry, `twin:` target | HTTP responses |
| recording | start/stop with ffmpeg absent → fallback path → upload | recording status, artifact |
| kill | module-level `os._exit` agent in the copied Grail → worker dies → app reports, does not hang | `/health` refused, outline error |
| windows | CRLF ring, `install.cmd` repair, `python` not `python3` | (CI matrix) |
| retention | 200 compositions → GC keeps last-good + active; worker logs rotate | dir counts, sizes |
| concurrency | second launcher on the same `BRAINSTEM_BETA_HOME` is refused by the lease; twins root is not wiped under a live owner | lease file, twin dirs |
| a11y | ⌘/Ctrl+Enter send, Enter in tile composers, logo Enter/Space | outline |
| shutdown | quit with an in-flight recording/loop/update — ordered teardown, no orphans | process table |

### 6. Order of work

1. `launch.mjs` + `BRAINSTEM_BETA_OWN_PORT` + model replay server + Surgeon fake; one scenario
   end to end (store hatch). This is the spine; nothing else is worth building before it runs
   green on all three OSes in CI.
2. UI Driver v2 (handles, outlines, verified effects, traces) — it is both the UX fix and the
   assertion layer.
3. The 24 scenarios above, then the remaining matrix rows, each linked from its matrix row.
4. T3 cassette refresh job and the "unknown fingerprint" diff reporter.

A matrix row is "covered" only when its scenario is linked in the `Existing tests` column and
runs in CI; the matrix is regenerated from the suite's manifest, not edited by hand.

## How to run and record

The harness shows its window on every platform. In a never-shown window the
cross-origin Brainstem frame gets no viewport on CI machines (macOS, Windows
and xvfb alike — every rect 0x0, the composer "not visible"), even though the
same hidden window lays out on a developer Mac; one mode everywhere is the
deterministic choice, and it is the mode a person uses. Set
`BRAINSTEM_BETA_E2E_HEADLESS=1` to opt back into a hidden window locally.
When a live Frontier owns `~/.brainstem` on the machine running the suite, the
boot scenario excludes that app's volatile `logs/` and `routing/` from its
"user homes unchanged" comparison and says so.

The unit suite includes the harness contracts and skips Electron scenarios unless they are
explicitly enabled:

```bash
cd beta
npm test
BRAINSTEM_BETA_E2E=1 node --test tests/e2e
```

In PowerShell, set `$env:BRAINSTEM_BETA_E2E = "1"` before the second command. Local Electron
startup failures caused by a missing binary or display are reported as clean skips. CI installs
the locked Electron binary explicitly, runs Linux under `xvfb-run`, and sets
`BRAINSTEM_BETA_E2E_REQUIRED=1` so an unavailable Electron runtime fails the job instead.

Cassette recording is a human-only operation against the developer's existing Copilot cache.
Point the recorder at that cache, opt in explicitly, and drive only the scenario being captured:

```bash
cd beta
RAPP_MODEL_ALLOW_RECORD=1 \
RAPP_MODEL_REAL_CACHE="$HOME/.brainstem/src/rapp_brainstem/.copilot_session" \
node --input-type=module <<'NODE'
import path from "node:path";
import { launch } from "./tests/e2e/harness/launch.mjs";

const app = await launch({
  modelMode: "record",
  replayCassette: path.resolve("tests/e2e/fixtures/my-scenario.json"),
  scenario: "record-my-scenario",
});
try {
  await app.driver.command({ action: "chat", value: "the scenario prompt" });
} finally {
  await app.stop();
}
NODE
```

Record mode proxies `/models` and `/chat/completions` with the cached real token. It stores
normalized requests plus the raw response body required for byte-faithful replay; authorization
headers and cache credentials are never written. Treat recorded model text as reviewable data and
inspect the cassette diff before committing it. Replay fails on an unknown fingerprint and reports
the nearest entry plus a structural diff.
