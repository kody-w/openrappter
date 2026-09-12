# RAPP Work workspace

A conversation-first React/TypeScript desktop with three columns: business
workspaces/roster, Twin conversation and complete reviews, and a persistent
shared-computer panel. The four record areas remain:

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
It imports the host's pure DTO schemas; no host implementation or Node
dependencies enter the renderer. Agent and assigned-work DTOs carry the actual
independently minted workspace ID. Uncertain outcomes remain visibly unresolved.

The host is authoritative for records and settings. Event subscriptions trigger
snapshot refreshes, are cleaned on disconnect, and never create synthetic runs.
Last-loaded work is identified as stale and mutation controls are disabled when
disconnected. Computer “running” and “verified” are separate service assertions;
missing services cannot become a successful result.

Every RPC and subscription is bound to the selected authorized business.
Selection immediately clears computer state, draft editors, artifact content
and pending-response ownership. Late responses from another workspace cannot
replace the selected view or transfer a lease. The desktop's preload and main
process share the same pure RPC parameter schemas as the host.

## Intent, then review

New workspace, agent, task, routine and settings actions focus the Twin's
single intent/document composer. They never open a blank create form.
`ProposalReview` refuses to render a form without a complete, hash-bound,
workspace-matching proposal. Existing-record reviews require the full record
and membership in the selected snapshot. Settings are initially read-only;
the Twin proposes changes and the review merges them with complete current
values.

Pasted Markdown documents are retained verbatim, including locked evidence
phrases and line endings. Oversized input stays visible with an explicit
error; it is never silently truncated. A document already supplied to the
concierge is retained when the necessary follow-up is selecting its business.
The instruction text in a document-backed proposal is read-only; submit a
revised document to change its restrictions. Suggested routines remain
disabled until another explicit review.

The prominent **Start agent computer** control uses `computer.start` for the
current business. The right panel distinguishes shared VM state, workspace
enablement, actual current lease/agent, approval policy, and display
availability. Unavailable/unresolved states disable startup; no screen is
invented for the headless driver. Each operation obtains a fresh scoped broker
lease, and agent policies still apply after starting the VM.

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
injected test bridge, long pasted instructions, complete draft reviews,
approvals, artifacts, workspace-scoped computer start/switching, keyboard focus,
three-column positioning, and WCAG checks in both themes at 1360px and 375px.
Screenshots/traces are app-local in ignored `test-results/`. Fixtures exist only
under `test/` and `e2e/`; their separate in-memory test bundle is injected only
by Playwright and is never included in the production bundle.

The browser tests do not verify a real execution runtime or virtual machine.
Actual Electron/host persistence is covered by the desktop smoke test.
