# RAPP Work Release Constitution

The production product is **RAPP Work**, bundle `com.rapp.work`, for **macOS
Apple Silicon**. The selected protocol is the accepted RAPP/1 checkpoint in
`rapp1-authority.json`. A fixture result is evidence of that test, not a claim
that a particular binary is signed or that a real computer executed work.

## Non-negotiable gates

1. All source files, file types, executable modes and lockfiles are inventoried.
   Production requires the exact clean committed repository, not a selected
   source folder or a version string. Submodules and escaping links are refused.
2. The application contains a sealed build receipt binding its complete source
   digest, complete lock digest, selected authority and the complete
   `packages/rapp1/fixtures` digest.
3. Every packaged app path, ASAR module, unpacked module and extra resource is
   checked against the clean artifact policy. The scanner has only exact wire
   literal and inert migration-fixture exemptions. Policy definitions are data
   for the scanner, not executable product exemptions.
4. Every native executable is arm64. Production requires Developer ID signing
   by the independently selected Apple team, hardened runtime, secure signing
   timestamps, successful Gatekeeper assessment, notarization and stapled
   tickets for both application and DMG.
5. An Ed25519 signature seals the complete provenance envelope. The public key
   and Apple team are trusted independently; a key supplied by an artifact
   cannot authorize that artifact. Both the DMG checksum and the complete
   mounted application's tree must match.
6. Unsigned development is a separate, explicit mode, named in the receipt,
   manifest, DMG filename and volume. It installs as **RAPP Work Development.app**,
   never over the production application. It is not a production release.
7. Installation verifies before mutation, copies into a private same-filesystem
   transaction, verifies the copy, and uses `renamex_np(RENAME_SWAP)` for an
   existing app or `RENAME_EXCL` for a first install. A synced journal and retained
   previous bundle permit rollback. Uncertain helper outcomes are reconciled by
   both app digests; an unknown state stops without deleting either app.
8. Normal startup does not discover prior homes. Migration is a separately
   selected reviewed **data-only** operation. Imported data cannot grant
   permissions, choose ownership, install code, restore credentials, authorize
   approval, or enable automatic execution. Original sources are retained.
9. Missing persistence or an unavailable computer produces zero business
   execution. An uncertain outcome is unresolved, not automatically replayed.
   No guest failure may become host-shell execution.
10. All nine scenarios in `acceptance.json` must execute and pass. A skip,
    missing suite, fixture-only substitute for a runtime class, or empty report
    is not a release pass. The actual native atomic replacement helper is also
    compiled and tested on the supported target.

## Commands

```sh
node scripts/check-release-constitution.mjs
node scripts/run-acceptance.mjs
```

The runtime acceptance uses the real workspace store, capability authority,
work service, agent runtime, computer broker and host. Only external boundaries
are injected to count effects and simulate unavailable services. Frames-only
rebuild retains mint-once identity and trusted commit heads; it copies no
projection, cache or application database. Integrity-checked unsigned RAPP/1
frames are not presented as independently authenticated authorship.

`release-macos.yml` is the only production publication workflow. It runs in
the protected `production` environment, checks the tag against the workspace
version, and publishes only after independently remounting the final artifact.
Private signing inputs live only in the runner's ignored build directory and
are removed even on failure. No other platform or distribution train is implied.
