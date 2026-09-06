# Commit-pinned tools and governed releases

Local development and distribution are different operations:

| Tool | Contract |
| --- | --- |
| `install.sh` | Resolve an authority-backed release ring to an exact source/artifact identity. |
| `install-pinned.sh` | Build a developer-selected exact commit locally, with locked dependencies and runtime provenance. |
| `scripts/pinned-release.mjs notes` / `hashes` | Read commit blobs and print notes or installer hashes; no publication. |
| `scripts/pinned-release.mjs publish` | Request the canonical **Release Constitution** workflow for an exact identity; never create a release directly. |

All tags, GitHub releases, registry packages, and installer channels remain
governed by `openrappter-release-constitution/v1`. Finalized immutable receipts
must describe the same commit, version, and artifact in order
nightly → alpha → canary → beta. No source-only publication exception exists.
Rollback may use only an already-receipted artifact and needs its own receipt.

## Inspect an exact commit locally

Use a full 40-hex commit, not a branch, short SHA, or annotated-tag object:

```sh
node scripts/pinned-release.mjs hashes --commit "$release_commit"
node scripts/pinned-release.mjs notes --commit "$release_commit" --version "$version"
```

The hashes come from Git blobs, not working-tree bytes. These read-only commands
and local builds do not require promotion receipts.

The pinned installer retains its local guarantees: verified portable Node,
`npm ci`, a lockfile-pinned Copilot CLI with a verified digest, a provenance
record, no global installation, and no automatically started service.

## Request a distribution

First merge the tested source/version and build one immutable release candidate.
Complete the ring journey and stable review/finalization through the authority's
normal process; see [release rings](docs/release-rings.md). Never create a tag to
try to satisfy a receipt requirement.

Inspect the request without dispatching:

```sh
node scripts/pinned-release.mjs publish --dry-run \
  --commit "$release_commit" --version "$version"
```

After owner approval, omitting `--dry-run` requests
`create-release-tag.yml` on canonical main, passing both `expected_commit` and
`expected_tag`. That workflow requires the exact finalized stable identity and
validates the full constitutional receipt chain before its privileged tag job.
The command's success means **requested**, not **published**. Inspect the exact
workflow results; it cannot create an unreceipted release or silently substitute
whatever stable identity happens to exist.

Do not use manual `git tag`, direct GitHub release creation, or registry uploads
as an alternative. Existing tags/assets are immutable; corrections require a
new reviewed version and complete receipt chain.

## Native Bar

The native Bar must be included in the immutable candidate before promotion.
Its release workflow verifies and reuses the signed/notarized/stapled DMG,
re-downloads the published artifact, and prepares a receipt-bound cask proposal.
See [macOS signing and delivery](macos/SIGNING.md).
