# RAPP Work for macOS

One Electron application for **macOS arm64**, one multi-workspace window, one tray,
and one owned host utility process. It does not attach to an existing daemon.
No secondary window/bar, voice-model payload, or non-Node runtime is shipped.

## Build

Install the clean workspace from the root lockfile:

```sh
npm ci
npm run build
cd apps/desktop
npm run typecheck
npm test
npm run build
npm start
```

The desktop build stages only the built host bundle and UI, and generates its
own RAPP Work PNG/ICNS/tray assets. It fails if either application has not been
built. Packaging is restricted to macOS arm64 DMG/ZIP:

```sh
npm run package
```

For a local unsigned directory build without certificate auto-discovery:

```sh
mkdir -p .test-scratch
TMPDIR="$PWD/.test-scratch" \
  ELECTRON_BUILDER_CACHE="$PWD/node_modules/.cache/electron-builder" \
  ELECTRON_CACHE="$PWD/node_modules/.cache/electron" \
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:dir
```

Signing and notarization are separate release responsibilities; a local package
build does not attest to either.

## Desktop boundary

* Sandboxed, context-isolated renderer; Node integration, webviews, development
  tools, new windows, renderer downloads, and general browser permissions are disabled.
  The only media exception is microphone audio requested by the **owned,
  focused, visible, top-level `rapp-work://app/index.html` document**. Both
  permission checks and requests reject subframes, foreign windows, remote
  documents, camera/display capture, missing media type, and background access.
  macOS microphone consent is requested only from that trusted request path;
  the bundle declares `NSMicrophoneUsageDescription` and audio-input entitlement.
* The secure `rapp-work://app/index.html` protocol serves only app resources,
  rejects path/symlink escapes, and supplies a restrictive CSP. The renderer
  cannot make network connections. The theme bootstrap uses a CSP hash.
* The frozen preload exposes exactly `request`, `hostState`, and `onEvent`.
  Both preload and main enforce the host's shared `rpcParameterSchemas` closed
  method allowlist and strict parameters; no separate wire schema is maintained.
  Main accepts requests only from the owned top-level application frame.
  Business and recursive agent-workspace operations and event subscriptions/unsubscriptions carry an explicit
  `workspaceId`; only the global concierge accepts `null` where documented.
  Twin requests use the exact host message envelope and bounded human/assistant
  history. Applying/dismissing a proposal uses its canonical ID and hash.
  Approval recommendations cannot become approval decisions through that API.
  Model drafting has a bounded 200-second transport deadline; ordinary requests
  retain the shorter 30-second deadline. Timed-out mutations are not replayed.
* Main generates a fresh secret, sends it over private parent/child IPC, validates
  a versioned readiness handshake, and performs an authenticated health probe.
  Credentials, endpoints, arbitrary IPC channels, filesystem paths, and shell
  execution are not exposed to the renderer.
* Startup is bounded. Concurrent starts share one process. Unexpected exit
  invalidates the lease; Refresh can start a new owned host. Closing the window
  hides it in the tray; explicit Quit stops the owned process, forcibly if needed.
  Safe startup failure/deadline details are retained, and a late exit from a
  superseded child cannot disconnect its replacement.
* The production user-data path is explicitly the new RAPP Work directory.
  One owner, independent durable business roots, bounded agent-owned child
  workspaces, frame-derived lineage/Twin history, and private execution stores
  live beneath it.
  Unpackaged smoke runs can isolate data with
  `RAPP_WORK_USER_DATA`; packaged applications ignore that override.

Host connection does not mean provider/computer readiness. The composition
uses real public-package adapters and reports missing authentication,
configuration or image explicitly. See [setup](../../docs/LOCAL_PRODUCTION.md).

Voice uses the browser's SpeechRecognition implementation, if available. It may
use an online browser speech service; it is not an offline transcription
promise. The UI starts capture only from an explicit button click, displays
listening/results/errors, appends only final transcripts for review, and stops
on blur, hiding, workspace switching, inspector opening, disconnect, or unmount.
It never auto-sends a transcript or records in the background. Unsupported or
denied speech has a text fallback and is not reported as successful.

## Tests

`npm test` runs contract, preload, trusted microphone permission, resource-boundary, real WebSocket, and
injected-process lifecycle tests without launching Electron or depending on
other packages.

After building all three apps on macOS arm64:

```sh
npm run test:smoke
```

The smoke test requires the canonical fractal/Twin host, launches the actual shell
and bundled host, and verifies the preload/renderer boundary, authenticated
connection, scoped records, prefilled reviews, workspace switching, settings,
restart persistence, private file permissions, and owned-process shutdown.
It seeds **complete reviewed test inputs through real canonical RPCs** rather
than opening blank UI forms or making a paid model call. Prefilled UI edits are
checked to return to the Twin rather than bypass source verification. Natural-language
proposal behavior and dictation are separately covered by the UI's injected
browser tests. The smoke gate does not claim live inference, microphone
permission dialogs, speech transcription, or guest/VM execution.
The UI's separate `test:canonical` gate verifies nonzero canonical frames and
rebuilds all workspace projections from them. Local integrity is never a claim
of factual truth, authorship, or promotion-grade trust.
The isolated profile is removed; a screenshot and result JSON remain in the
ignored `test-results/` directory.
