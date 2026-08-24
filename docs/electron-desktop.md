# OpenRappter Electron Desktop

OpenRappter Desktop applies Skill Recorder's desktop ergonomics without
forking OpenRappter's runtime.

## Architecture

```text
Electron main process
  ├─ launches or reuses the local OpenRappter gateway
  ├─ loads the packaged current Lit UI from disk
  ├─ owns native confirmation dialogs
  ├─ owns local Whisper and VibeVoice services
  ├─ owns the authenticated desktop command queue
  └─ exposes narrow context-isolated IPC methods

Sandboxed renderer
  └─ Brainstem Frontier Grail + native OpenRappter modules

Packed OpenRappter runtime
  ├─ TypeScript gateway and agents
  ├─ built UI assets
  └─ Electron-specific better-sqlite3 binding
```

The system Node installation and Electron never share a native SQLite binary.
`desktop/scripts/install-runtime.mjs` packs the current OpenRappter package,
installs it under `desktop/runtime`, and rebuilds only that copy for Electron.

`beta/ui` is the Grail renderer source used by both hosted and Electron builds.
The package build places Grail at `ui/dist` and the prior Lit dashboard at
`ui/dist/legacy`; Electron loads Grail by default. No copied shell or iframe is
used to embed Legacy.

## Development

```bash
cd typescript
npm install
npm run build

cd desktop
npm install
npm start
```

## Build an application

```bash
cd typescript/desktop
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist -- --dir
```

Electron Builder targets:

- macOS: DMG and ZIP
- Windows: NSIS
- Linux: AppImage

Production signing/notarization credentials remain external to the repository.
macOS releases require the documented Apple certificate and notarization
secrets. Windows releases require `WINDOWS_CERTIFICATE_P12_BASE64` and
`WINDOWS_CERTIFICATE_PASSWORD`; unsigned `.exe` assets are rejected.

## Security boundary

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webSecurity: true`
- the preload is CommonJS because sandboxed Electron preloads cannot rely on
  the app's ESM package mode
- external navigation is denied and opened in the system browser
- the local packaged UI is separate from whichever gateway version is running
- WebSocket requests are restricted to the loopback gateway origin
- the renderer cannot mint consent tokens or receive frame paths
- recording, active-window capture, approval, and deletion require native
  main-process confirmation

## Autonomous chat control

The packaged gateway exposes a `DesktopControl` agent to ordinary OpenRappter
chat. The agent sends typed commands through a private `0700/0600` queue; the
Electron main process consumes them and the renderer executes semantic
shadow-DOM operations.

Always snapshot before using refs:

```text
Use DesktopControl to snapshot the UI, navigate to show-and-tell, fill the
session title and intent, then take another snapshot to verify the values.
```

Hot-loaded Python and TypeScript agents may return:

```json
{
  "status": "success",
  "ui_commands": [
    { "action": "navigate", "view": "agents" }
  ]
}
```

Agent installation is a different, higher-risk action. The Electron main
process scans declared/implied capabilities, shows the SHA-256 and capability
summary in a native dialog, compiles `*_agent.ts` to the factory-based
`*_agent.js` format, and delegates to OpenRappter's rollback-safe hot loader.

## Local narration and voice

### Whisper “tell”

- model: `Xenova/whisper-small`
- q8 ONNX weights, approximately 252 MB
- 16 kHz mono transcription
- cached under Electron user data
- audio and transcription remain local
- transcript is appended to the active Show-and-Tell timeline

### VibeVoice speech

- source: `microsoft/VibeVoice`
- pinned commit: `94da20d98b2fa7688e9cbfaf7692ddb4954f7600`
- model: `microsoft/VibeVoice-Realtime-0.5B`
- pinned model revision, grouped for readability:
  `6bce5f0604` `4837fe6d2c` `5d7a71a84f` `0416bd57e4`
- pinned Qwen tokenizer revision, grouped for readability:
  `060db6499f` `32faf8b984` `77b0a26969` `ef7d8b9987`
- approximately 2.04 GB model weights
- private Python 3.11 environment
- MPS on Apple Silicon, CUDA where available, CPU fallback
- loopback-only Uvicorn server with access logs disabled
- WAV playback through the Electron bridge

VibeVoice is an optional preview. Synthetic speech must not be used for
impersonation, deception, fraud, or undisclosed deepfakes. Microsoft publishes
the repository and model under MIT while the model card adds responsible-use
restrictions; deployments should preserve both notices and obtain legal review
before commercial distribution.

## Menu bar integration

Electron includes a tray with quick chat, Show-and-Tell, local voice, launch at
login, and optional OpenRappter Bar launch. It publishes
`~/.openrappter/desktop-gateway.json` with owner-only permissions. The Swift Bar
validates the file, process, host, port, and token, then authenticates to that
gateway instead of creating another daemon.

## Slow gateway startup

The desktop app will not open a window until the gateway it spawned reports
itself ready. That budget is **30 seconds**, and when it runs out the gateway is
killed and startup fails with:

```
OpenRappter gateway did not become ready in 30 seconds.
```

A gateway that genuinely fails to start is reported immediately by its exit,
so this particular message only appears when the process is alive and merely
slow — a cold first run resolving modules, an antivirus scan, or a heavily
loaded machine.

If that is your machine, raise the budget:

```bash
export OPENRAPPTER_GATEWAY_READY_TIMEOUT_MS=90000
```

Values must be a plain positive integer of milliseconds. Anything else is
ignored in favour of the 30s default rather than being treated as fatal, and
the accepted maximum is ten minutes so that a mistyped value cannot hang
startup indefinitely.

Whether 30 seconds is the right default is still open (issue #223); this
variable exists so that nobody has to wait for that answer to start the app.

## Deterministic smoke

`OPENRAPPTER_DESKTOP_SMOKE=1` launches the real Electron app, verifies the
preload bridge, gateway connection, visual Show-and-Tell component, recorder
IPC, and SQLite binding, then exits.
