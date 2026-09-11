# RAPP Work Desktop

**Your local AI workforce.**

Electron is the desktop host, not a fork of the runtime. It launches or reuses
the packaged OpenRappter gateway, opens the same **Work** view as the web UI,
and exposes one context-isolated IPC bridge for Show-and-Tell. Work combines
an agent roster, isolated-workspace indicators, threads, run receipts,
approvals, evidence, and a shared local Omarchy computer panel.

Specialist and legacy views remain under **Compatibility**. Missing workspace
methods enable labeled read-only examples; missing VM methods do not simulate
a running computer. See [RAPP Work contracts](../../docs/rapp-work.md).

Work mutations require the [canonical RAPP/1 adapter](../../docs/rapp-work-rapp1.md).
The renderer checks frame hashes and lineage and labels verification per item;
unverified compatibility output is not certified history.

```bash
cd typescript/desktop
npm install
npm start
```

The main process owns native confirmation dialogs for recording, screenshot
capture, workflow approval, and deletion. The renderer never receives consent
tokens, raw recording-frame paths, Node.js access, or raw Electron APIs through
that bridge. Work's workspace paths are intentionally gateway-reported projections.

## Product identity and upgrades

The macOS product is **RAPP Work.app**, with executable
`Contents/MacOS/RAPP Work` and artifacts named
`RAPP Work-<version>-mac-<arm64|x64|universal>.dmg`.

This is a display-name migration, **not a new application identity**. Keep the
existing reverse-DNS `com.openrappter.desktop` appId/CFBundleIdentifier. Changing
it during a rename would create a different macOS signing/designated-requirement
identity and could reset TCC permissions, keychain access, Launch Services
associations, or updater identity. A future appId migration needs an explicit,
signed migration release and an upgrade/permission test matrix; it must not be
bundled into a cosmetic rename.

The npm names `openrappter-desktop` and `openrappter`, repository/release channel,
IPC names, and runtime/data paths remain compatibility identifiers. No top-level
`package.json.productName` override or storage migration is introduced here.
Windows `OpenRappter.exe` and Linux `openrappter` executable names remain stable;
their installer display names use RAPP Work. The separate OpenRappter Bar is
unchanged. An old `/Applications/OpenRappter.app` is **never removed automatically**.
Quit it before launching RAPP Work: both retain the same appId.

## Building and verifying release artifacts (no installation)

Use the locked dependencies and build the core first:

```bash
cd typescript
npm ci
npm run build
cd desktop
npm ci
npm run build
npm test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist -- --mac dmg --arm64 --config.mac.notarize=false
npm run release:manifest -- --arch arm64
```

Build `x64` on an Intel Mac; local builds use native runtime dependencies and do
not claim cross-compilation support. Supplied universal DMGs can be verified and
installed, but building one requires separately validated universal native
dependencies. The signed release workflow retains its signing and notarization
gates; the command above creates a local unsigned/ad-hoc build, not a notarized
public release. `npm run dist` never
publishes. Re-run `node scripts/install-runtime.mjs` after changing core source
to refresh the packaged runtime before rebuilding the desktop.

The `afterPack` hook checks the canonical module's emitted JavaScript against its
current TypeScript source (rejecting a stale core build), compares the actual
ASAR's runtime authority module to that canonical build, obtains the selected
authority through `protocolAuthorityDetails`, and writes
`Contents/Resources/rapp-work-build.json` **before signing**. That build record
includes the build's full git commit and dirty-tree flag. No authority revision,
checkpoint, frame hash, payload hash, or normative/bootstrap hash is maintained
independently by the release scripts.

`release:manifest` selects the exact version/architecture filename (or accepts
`--dmg FILE --arch ARCH`), mounts it read-only, verifies its name, bundle ID,
executable, version, Mach-O architecture, build record, and packaged authority
bytes, then unmounts it. It emits `<dmg>.sha256` and `<dmg>.manifest.json` beside
the DMG. The manifest contains product/version/architecture, app identity, the
recorded git commit/dirty flag, canonical RAPP/1 authority identity and provenance,
source/compiled-module hashes, and DMG filename, size, and SHA-256. It is
byte-stable for the same build and DMG, without timestamps.
A missing record, stale runtime, altered authority claim,
or changed DMG fails closed. `--require-clean` rejects dirty local builds and is
required by both CI artifact lanes. These are integrity/provenance checks, not a
claim that an unsigned local build is publisher-authenticated.

CI uploads the DMG, checksum, and manifest together. The release workflow verifies
the original DMG checksum after artifact download and includes all three in the
existing release asset set. Nothing is published by the local scripts.

## Explicit local installation (macOS only)

**Run only when ready to install**, not as part of a build/test:

```bash
cd typescript/desktop
npm run install:local -- --dmg "dist/RAPP Work-1.13.0-mac-arm64.dmg"
# Or rebuild the core, packaged runtime, DMG, and release metadata first:
npm run install:local -- --build --arch arm64
# Only after inspecting the existing installation:
npm run install:local -- --dmg "dist/RAPP Work-1.13.0-mac-arm64.dmg" --replace
```

`--build` needs the installed development dependencies and builds only the host's
native architecture. A supplied DMG may carry another version, but must contain
the expected RAPP Work bundle identity and a
native or universal executable. If a SHA-256 sidecar is present it must match;
obtain both from a trusted source. No Gatekeeper/quarantine bypass, `sudo`,
automatic permission prompt, or forced process termination is used.

The installer fails before building/mounting when RAPP Work.app already exists
without `--replace`. Replacement also refuses symlinks, foreign bundle IDs,
running copies, concurrent installs, or destination changes while staging. It
copies with `ditto` into an exclusively created staging directory in
`/Applications`, validates the copy, unmounts, and uses same-filesystem renames
with a backup for replacement. Copy/unmount failures leave the old app in place;
rename/validation failures restore it when safe. Launch failure reports the
installed app and retains the previous app at the printed recovery path.
Only this run's staging/backup and lock are cleaned up; unrelated apps are
untouched.
Mount directories live under `desktop/dist`, never a shared system temp folder.
An unmount failure leaves its directory intact and reports the path for recovery.
Finally it launches the **exact** installed app path (not an appId/name lookup)
and reports the version read from the installed Info.plist.
