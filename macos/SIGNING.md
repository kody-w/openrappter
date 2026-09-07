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
3. The reusable **Build signed macOS Bar candidate bytes** workflow first builds
   dependency-complete runtimes on **macos-14 (ARM64)** and **macos-15-intel (x64)**.
   Each job asserts its actual machine architecture, verifies the official Node
   archive and binary pins, and executes the real SQLite/Sharp dependencies,
   packaged Copilot `--version`, dashboard, and an offline mock gateway chat.
   Neither job uses signing credentials or a real model/account for its smoke.
   The signing job requires both architecture jobs, seals bootstrap metadata and
   its helper into the universal app, signs with Developer ID, submits to Apple's
   notary service, and staples the accepted ticket. Only afterward does it hash
   the DMG. Gatekeeper, bundle identity/source commit, sealed resources, and both
   architectures are checked.
4. The DMG, checksum, closed `macos-bar.json`, `runtime-bootstrap.json`, and sealed
   helper copy join the existing npm/wheel/sdist/installer bundle. Oversized
   runtimes become `<runtime.file>.parts.json` descriptors in that bundle;
   legacy small direct archives remain supported. Exactly one representation
   per architecture is allowed. The descriptors and normal **flat regular files**
   enter `provenance.json` and `SHA256SUMS` before the outer bundle is hashed.
   Runtime parts live outside the outer tar and are committed as its flat
   siblings in the **same immutable candidate commit and directory**, together
   with the outer tar, provenance and index. Parts and streamed reconstructed
   runtimes are verified before that single candidate-branch publication.
   Promote the same outer bundle digest through finalized immutable receipts in
   order nightly → alpha → canary → beta. No step may rebuild or skip a ring.
5. With owner approval, run **Release macOS Menu Bar** on main with that exact
   source commit and version. Its named **Release Constitution** job validates
   the full authority chain and local candidate bytes, including the native files.
   Materialization downloads and verifies every referenced runtime part before
   it can produce release evidence; unavailable or corrupt parts fail the job.
   Separate ARM64 and Intel macOS jobs verify the unchanged DMG; neither re-signs
   nor staples. Only then can publication create `vX.Y.Z-bar` and immutable assets.
   It derives the frozen four-receipt proof using `bar_candidate.py cask` and
   publishes the same proof bytes as **runtime-bootstrap-proof.json** on that
   exact Bar release. This post-gate evidence is not embedded in its own candidate.
   Public standalone runtime archives are reconstructed from verified parts,
   never rebuilt, and checked against the original sealed whole-archive hashes.
6. The workflow downloads the published DMG, both runtime archives, and proof
   again and compares them with the authorized bytes. A mismatch fails the run.

The package candidate's intended tag remains `vX.Y.Z`; the digest-bound
`macos-bar.json` additionally records the native tag `vX.Y.Z-bar`. The existing
authority supports this combined bundle without a new schema or exemption.
A package-only candidate, snapshot, missing native file, or changed DMG is rejected.
An independent Bar-only authority lane would require a separately reviewed central
contract change; this workflow does not pretend that one exists.

The DMG contains the Swift companion plus its **sealed first-launch download
contract**, not Node or the gateway runtime. First launch verifies the exact
official Node archive/binary, the frozen nightly → alpha → canary → beta chain,
the candidate bundle, its provenance/checksums, and the selected runtime archive.
The customer does **not** run `npm`, compile native modules, use a floating
package tag, or fetch executable bootstrap code from a mutable branch.
An unavailable proof, stale pin, incomplete archive, or unapproved candidate
fails closed rather than silently choosing an ambient runtime.
Local unsigned `build-mac-app.sh` builds remain available for development only.

## Producer pins and local verification

`macos/runtime-node-pins.json` pins the exact official Node release, archive and
extracted binary SHA-256/size for both architectures, and the Node module ABI.
The producer verifies those bytes **before executing Node** and compares the
running `process.versions.modules`, version, architecture, and platform with the
reviewed pins. Rotate the two pins together, build/test both targets again, and
produce a new source identity; never repair an already-promoted candidate in place.

`scripts/bar_runtime.py build` derives the Bar version from
`typescript/package.json`, uses source-controlled locks for `npm ci`, builds the
packaged UI/server, and installs production dependencies in a fresh isolated
home/staging directory. Every runtime contains the package, dependency lock,
licenses, UI, compiled server, production modules, and `runtime-build.json`
binding the source/locks/pins/native binaries. npm selects only the target
platform packages. The producer additionally removes only Copilot's five
explicitly foreign clipboard bindings and any opposite-architecture search-tool
executables; the matching bindings/tools, loaders, packages, and every license
remain. The omitted filenames are recorded. It never drops
Copilot, SQLite, Sharp, or other required dependencies to meet a size budget.
Before and after compilation, the producer rejects tracked changes or untracked
release inputs instead of labeling a dirty working tree with an unrelated HEAD.
Signed app builds apply the same exact-source guard; ordinary unsigned
development builds remain unaffected.

On a matching Mac (Intel can also be checked using the pinned x64 Node under
Rosetta), run from the repository root:

```bash
python3 scripts/bar_runtime.py build --architecture arm64 \
  --commit "$(git rev-parse HEAD)" --root macos/dist \
  --work .test-scratch/bar-runtime-arm64
python3 scripts/bar_runtime.py build --architecture x86_64 \
  --commit "$(git rev-parse HEAD)" --root macos/dist \
  --work .test-scratch/bar-runtime-x86_64
python3 scripts/bar_runtime.py manifest --root macos/dist \
  --commit "$(git rev-parse HEAD)"
python3 -m unittest discover -s tests -p 'test_bar*.py' -v
.test-scratch/bar-runtime-arm64/node/bin/node --test macos/Tests/verified-runtime-bootstrap.test.mjs
```

Use fresh work/output locations for a new attempt. These commands build/test
unprivileged candidate inputs; they do not sign, notarize, promote, or publish.
The producer validates normalized tar paths and native architecture, then the
actual sealed helper extracts each real archive for an offline package smoke.
Python fixtures are also checked against the actual bootstrap JSON schema and
helper, including a generated frozen proof and both candidate runtime variants.

## Approved chunk transport

The outer candidate keeps its existing immutable `raw.githubusercontent.com`
URL, authority schema, candidate namespace, and four-ring identity. No public
prerelease lane or policy bypass is introduced. `bar_runtime.py chunks` stages
oversized archives into a separate `candidate-parts/` directory; the normal
candidate directory receives only the corresponding descriptors.

The closed `openrappter-runtime-chunks/v1` descriptor contains:
`schema`, `source_commit`, `version`, `architecture`, `file`, `sha256`, `size`,
and `parts`. Each part has exactly `file`, `sha256`, and `size`. The whole-file
identity must equal the app's unchanged sealed `runtime` pin. Parts are indexed
from zero, numbered in order, and named
`runtime-ARCH-NNNN-SHA256.part`. There are 1–64 parts; every non-final part is
exactly 32 MiB, the final part is non-empty and at most 32 MiB, and their sizes
sum to the whole archive size. No descriptor or part may supply a URL.

The downloader derives each URL from the authorized outer candidate's directory
and exact part filename, preserving the same immutable candidate ref/path.
It verifies each part's size/SHA-256 and the streamed reconstructed archive's
size/SHA-256. Release verification additionally inspects the reconstructed
archive's source, locks, ABI and native files. Missing, changed, unlisted,
ambiguous or reordered data is rejected.

`build-candidate.yml` still enforces GitHub's 100 MiB limit on the **outer tar**.
Every part is below that limit. The approved split removes the large runtime
archives from the outer tar without dropping any dependency or changing its
sealed whole-file identity. If the outer tar still exceeds its budget, fail
rather than splitting unrelated artifacts or weakening the release gate.

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
