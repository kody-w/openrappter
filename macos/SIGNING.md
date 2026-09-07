# OpenRappter Bar signing and notarization

Public DMGs are signed with **Developer ID Application**, submitted to Apple's
notary service, stapled, mounted, and assessed by Gatekeeper before release.

## Repository secrets

The candidate-building and health workflows use the configured CI Developer ID
account and require:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_API_KEY_P8_BASE64`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`

Never commit `.p12`, `.p8`, or private-key material. Keep an encrypted,
access-controlled recovery copy outside the repository and GitHub.

The health check validates certificate expiry and notarization API authentication.
Its success is not proof that a new DMG has been built, notarized, or published.
No local Keychain extraction is needed to run the health check.

## Exact-artifact delivery

1. Merge the tested source and version through normal review. Use a new version;
   existing native tags and release assets are immutable.
2. With owner approval, run **Build immutable non-stable candidate** on canonical
   main with the exact source commit, `candidate_kind=release`, its intended
   package tag `vX.Y.Z`, channel version, and `include_macos_bar=true`.
3. The reusable **Build signed macOS Bar candidate bytes** job runs native tests,
   builds both architectures, signs using Developer ID, submits to Apple's notary
   service, and staples the accepted ticket. Only afterward does it hash the DMG.
   Gatekeeper, bundle version, bundle identifier, and both architectures are checked.
4. The DMG, checksum, and closed `macos-bar.json` record join the existing
   npm/wheel/sdist/installer bundle. Each file is included in candidate provenance.
   Promote the same outer bundle digest through finalized immutable receipts in
   order nightly → alpha → canary → beta. No step may rebuild or skip a ring.
5. With owner approval, run **Release macOS Menu Bar** on main with that exact
   source commit and version. Its named **Release Constitution** job validates
   the full authority chain and local candidate bytes, including the native files.
   A separate macOS job verifies the unchanged DMG; it does not re-sign or staple.
   Only then can the publication job create `vX.Y.Z-bar` and immutable assets.
6. The workflow downloads the published DMG again and compares its SHA-256 with
   the constitution-checked digest. A mismatch fails the run.

The package candidate's intended tag remains `vX.Y.Z`; the digest-bound
`macos-bar.json` additionally records the native tag `vX.Y.Z-bar`. The existing
authority supports this combined bundle without a new schema or exemption.
A package-only candidate, snapshot, missing native file, or changed DMG is rejected.
An independent Bar-only authority lane would require a separately reviewed central
contract change; this workflow does not pretend that one exists.

The DMG contains the Swift companion, not Node or a gateway runtime. Fresh-install
runtime provisioning/readiness is a separate application requirement.
Local unsigned `build-mac-app.sh` builds remain available for development only.

## Public Homebrew follow-through

`macos/homebrew/openrappter-bar.rb` is a repository reference, not the public tap.
After the public download passes verification, the release run emits
`homebrew-proposal-X.Y.Z`: a generated cask and `receipt.json` naming the immutable
authority receipt, candidate digest, exact version, public URL, and DMG digest.
It also preserves immutable references and digests for all four validated ring
receipts, so review need not confuse a later authority head with this release.
It does **not** push to the tap, merge a PR, or claim Homebrew is updated.

Before applying that proposal to `kody-w/homebrew-tap`, coordinate a reviewed PR
and a required **Release Constitution** check in the tap. That check must resolve
and validate the complete immutable receipt chain, verify the Bar entry inside
the candidate bundle, and independently hash the public DMG against the proposed
cask. The proposal's JSON is evidence to verify, not an authorization token.
Only a reviewed, passing proposal may update the public cask. Do not copy a cask
directly to protected main or use a generic package receipt for unrelated DMG bytes.

Authority/tap configuration and receipt finalization are external prerequisites;
merging this repository's code does not perform them automatically.

## Routine rotation

1. Create the replacement credential before revoking the old one.
2. For signing, create a **Developer ID Application** certificate using the G2
   intermediary and export its identity as a password-protected PKCS#12.
3. For notarization, create an App Store Connect API key with the minimum role
   required by Apple's notary service.
4. Replace all five repository secrets in one maintenance window.
5. Manually run **macOS Signing Health**.
6. Build a signed candidate through the procedure above and verify:
   - `codesign --verify --deep --strict`
   - `xcrun stapler validate`
   - `spctl --assess` reports `Notarized Developer ID`
7. Revoke the old credential only after the replacement candidate passes.
   Public distribution still requires every finalized ring receipt.

The weekly health workflow opens an Issue when the certificate has fewer than
90 days remaining or the notarization API key no longer authenticates.

## Suspected compromise

1. Revoke the affected certificate or API key in Apple Developer/App Store
   Connect immediately.
2. Disable Bar releases until replacement secrets validate.
3. Audit recent release workflow runs and published asset digests.
4. Replace the credential, run the health workflow, and publish a new release.
5. Document affected versions and advise users to update if artifact integrity
   is uncertain.

Use `™`, not `®`, for **RAPP + X™** until trademark registration is granted;
Apple signing/notarization and RAR receipts are separate trust systems.
