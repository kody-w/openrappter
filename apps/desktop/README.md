# RAPP Work for macOS

One Electron application for **macOS arm64**, one workspace window, one tray,
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
  tools, new windows, renderer downloads, and browser permissions are disabled.
* The secure `rapp-work://app/index.html` protocol serves only app resources,
  rejects path/symlink escapes, and supplies a restrictive CSP. The renderer
  cannot make network connections. The theme bootstrap uses a CSP hash.
* The frozen preload exposes exactly `request`, `hostState`, and `onEvent`.
  Both preload and main enforce a closed method allowlist and strict parameters.
  Main accepts requests only from the owned top-level application frame.
* Main generates a fresh secret, sends it over private parent/child IPC, validates
  a versioned readiness handshake, and performs an authenticated health probe.
  Credentials, endpoints, arbitrary IPC channels, filesystem paths, and shell
  execution are not exposed to the renderer.
* Startup is bounded. Concurrent starts share one process. Unexpected exit
  invalidates the lease; Refresh can start a new owned host. Closing the window
  hides it in the tray; explicit Quit stops the owned process, forcibly if needed.
* The production user-data path is explicitly the new RAPP Work directory.
  One owner and a canonical per-agent workspace store live beneath it.
  Unpackaged smoke runs can isolate data with
  `RAPP_WORK_USER_DATA`; packaged applications ignore that override.

Host connection does not mean provider/computer readiness. The composition
uses real public-package adapters and reports missing authentication,
configuration or image explicitly. See [setup](../../docs/LOCAL_PRODUCTION.md).

## Tests

`npm test` runs contract, preload, resource-boundary, real WebSocket, and
injected-process lifecycle tests without launching Electron or depending on
other packages.

After building all three apps on macOS arm64:

```sh
npm run test:smoke
```

The smoke test launches the actual Electron shell and bundled host, verifies the
preload/renderer boundary and authenticated connection, creates real local agent
and task records, changes typed settings, restarts the app, checks persistence
and private permissions, and ensures the owned host does not survive Quit.
It verifies runtime availability, while the isolated profile's provider setup
and computer remain unavailable; it does not perform model/guest work.
The isolated profile is removed; a screenshot and result JSON remain in the
ignored `test-results/` directory.
