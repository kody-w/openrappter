# Frontier semantic UI plans

Frontier tests and autonomous agents drive the visible product through one
closed protocol. They do not evaluate JavaScript, address arbitrary selectors,
call shell commands, or invoke Electron IPC directly.

## Console API

The existing deterministic `rapp()` command surface remains the in-page
primitive. When Frontier is launched with
`OPENRAPPTER_SEMANTIC_CONTROL=1`, the shell additionally exposes:

```js
await openrappter.ui.run({
  schema: "openrappter-ui-plan/1.0",
  name: "inspect-frontier",
  actions: [
    { action: "inspect_state", target: "shell" },
    { action: "assert_visible_text", text: "OpenRappter" }
  ]
});
```

`openrappter.ui` is absent in normal production launches. The API rejects a
second simultaneous plan rather than allowing two autonomous cursors to race.
The person's input still wins any contested gesture.

## Headless CLI

Validate a plan without starting Frontier:

```bash
cd beta
npm run ui:run -- --plan tests/e2e/fixtures/bookfactory-semantic-plan.json --validate-only
```

Launch a packaged application in an isolated home, run the plan, write a
redacted JSONL trace and screenshots, then stop the application:

```bash
npm run ui:run -- \
  --app release/mac-arm64/OpenRappter.app \
  --brainstem-source ../rapp_brainstem \
  --plan tests/e2e/fixtures/bookfactory-semantic-plan.json \
  --home .openrappter-ui-runs/bookfactory
```

Use `--source` for the locked development Electron or `--metadata` to connect
to an already-running, explicitly enabled Frontier. CI should run the packaged
application under its existing display facility (for Linux, `xvfb-run`) so the
same visible layout and actionability checks a person gets remain active.

The CLI reads the existing token-authenticated UI-driver metadata, sends only
`/v1/command` requests, and relies on that driver's frame queue and watchdog.
It does not create another browser automation stack.

## Action catalog

| Action | Meaning |
|---|---|
| `inspect_state` | Read the bounded semantic outline for `shell` or `brainstem`. |
| `select_store_item` | Open the visible herd and RAPP Store, then wait for a pinned item row. |
| `hatch` | Click that item's visible Hatch button and discover the resulting twin tile. |
| `wait_status` | Wait for a twin tile to display `ready`, `working`, `needs-auth`, or `error`. |
| `send_chat` | Type into the visible Brainstem or twin composer, click its real Send control, and optionally wait for reply text. |
| `click_known` | Click one allowlisted `data-drive` handle. Arbitrary selectors are rejected. |
| `assert_visible_text` | Wait for text rendered on the visible shell or Brainstem surface. |
| `assert_state` | Assert a known handle is visible, enabled, disabled, or focused. |
| `screenshot` | Capture the Frontier window through the existing driver artifact path. |

Plans contain at most 40 actions and 64 KiB, run for at most ten minutes, and
have per-action text and timeout bounds. Unknown fields, JavaScript, selectors,
install commands, forged results, traversal names, malformed JSON, stale
driver metadata, and concurrent plans fail closed. Traces redact credentials,
queries, local roots, email addresses, and IP addresses.

There is deliberately no `install` action. Hatching uses the same visible
button as a person and honors disabled/gated rows. Agent or capability install
approval remains on the existing human path and cannot be bypassed by a plan.

Twin runtime directories and their per-run workspaces are intentionally
removed when a twin or Frontier stops. A rapplication's stable Molter home is
the restart-persistent state. Docking and reopening the herd preserves a live
twin during that run; restarting Frontier does not silently resurrect and run
third-party code.

## Testing like a person

A UI feature is complete only when a semantic journey:

1. launches the real Frontier in an isolated home;
2. reaches the feature through visible `data-drive` controls;
3. verifies the visible effect or persisted state;
4. captures a redacted trace (and a screenshot for user-visible failures);
5. fails if the control is hidden, disabled, or occluded.

Coordinates and CSS scraping are not evidence. Tests may use selectors only in
legacy harness code while a semantic handle is being added; new journeys use
the action catalog above.

## Public-pattern attribution

The command architecture review included
[`vorssaint/vorssaint-utils`](https://github.com/vorssaint/vorssaint-utils) at
commit `006ce95389ba35346ebf88db87cfb1a5501bd68a`. Useful open patterns were a
closed command catalog, explicit confirmation/setup states, bounded execution
and output, generation ownership that discards stale completion, and
pure-function tests around dispatch/ranking.

That repository is GPL-3.0-or-later. OpenRappter is Apache-2.0, so no Vorssaint
source, branding, strings, or toolkit code was copied. The patterns above were
reimplemented independently against Frontier's existing UI-driver protocol.
