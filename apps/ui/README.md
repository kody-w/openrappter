# RAPP Work workspace

A React/TypeScript desktop workspace with exactly four primary areas:

* **Work:** task creation/assignment, run history/cancellation, scoped approvals,
  artifacts and evidence, and service-reported local computer state.
* **Agents:** a persistent sidebar roster and editable responsibility, model,
  computer-access, and approval configuration.
* **Automations:** daily, weekly, and interval schedules, including explicit
  drafts, time zones, and runtime-confirmed activation.
* **Settings:** typed workspace/appearance/notification preferences, provider
  connection references, approval policy, and diagnostics.

There is no production sample data, direct network connection, filesystem access,
credential input, or arbitrary Electron IPC. The browser build starts in an
honest disconnected state unless given a `WorkClient`.

## Injection boundary

`App` accepts the structural `WorkClient` interface in `src/client.ts`. The
production `BridgeClient` uses only the preload's `request`, `hostState`, and
`onEvent` functions. `src/model.ts` validates every input and response at runtime.
These app-owned schemas intentionally do not import unintegrated packages.

The host is authoritative for records and settings. Event subscriptions trigger
snapshot refreshes, are cleaned on disconnect, and never create synthetic runs.
Last-loaded work is identified as stale and mutation controls are disabled when
disconnected. Computer “running” and “verified” are separate service assertions;
missing services cannot become a successful result.

## Interaction and accessibility

The layout has keyboard-operable navigation and tabs, named form controls,
native modal dialogs with explicit focus containment/restoration, a skip link,
live error/status announcements, reduced-motion support, and responsive
375px–desktop layouts. Both light and dark themes use locally defined design
tokens; no external fonts or assets are loaded. Appearance and density are saved
through typed settings, not a renderer-only preference cache.

## Build and tests

From `apps/ui`:

```sh
npm ci --workspaces=false
npm run typecheck
npm test
npm run build
```

To install the browser and run acceptance checks while keeping browser scratch
data and downloads inside the application:

```sh
mkdir -p .test-scratch
export TMPDIR="$PWD/.test-scratch"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/ms-playwright"
./node_modules/.bin/playwright install chromium
npm run test:browser
```

The browser suite serves the **production build**, checks a real disconnected
cold load, exercises the main workflow twice, tests persistence through an
injected test bridge, approvals, artifacts, schedules, provider references,
diagnostics, keyboard focus, and WCAG checks in both themes at 1360px and 375px.
Screenshots/traces are app-local in ignored `test-results/`. Fixtures exist only
under `test/` and `e2e/`; they are never bundled into production.

The browser tests do not verify a real execution runtime or virtual machine.
Actual Electron/host persistence is covered by the desktop smoke test.
