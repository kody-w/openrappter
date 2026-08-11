# Releasing OpenRappter (commit-pinned channel)

OpenRappter has two installation paths, and they make different promises.

| Path | Command | What it pins |
| --- | --- | --- |
| Branch install | `install.sh` | Nothing. Clones a branch; the code moves. |
| **Pinned install** | `install-pinned.sh` | An exact commit, an exact lockfile, and an exact GitHub Copilot CLI binary. |

This document covers the pinned channel. It follows the same discipline as the
Skill Recorder release process: **source-only, commit-addressed, and verifiable
before execution**.

## Why pinned releases exist

A branch install cannot answer the question "what did I actually run?". Two
people running the same one-liner a minute apart can get different code. Worse,
until the local-repo pattern landed, the component that does the actual
reasoning — the GitHub Copilot CLI — was resolved from ambient machine-wide
paths (`/opt/homebrew/bin/copilot`, `/usr/local/bin/copilot`, VS Code's
`globalStorage`). Its version was decided by whoever last ran `copilot update`,
and its bytes were never checked.

A pinned release fixes both:

- the **source** is a 40-character commit SHA, and the installer refuses
  anything shorter or any branch name;
- the **Copilot CLI** is `@github/copilot`, a lockfile-pinned dependency
  installed by `npm ci` into the source tree's own `node_modules`, whose
  SHA-256 is stamped at build time and re-verified on every later run.

## 1. Prepare the release commit

Choose the next semantic version and update `typescript/package.json`. Nothing
else carries the version — `typescript/src/version.ts` reads it from there, so
the gateway's `/health`, `/status`, and RPC responses follow automatically.

```sh
cd typescript
npm version 1.10.1 --no-git-tag-version
```

Validate before tagging anything:

```sh
cd typescript
npx tsc --noEmit
npm run build
npx vitest run
```

Commit and push to `main` through the normal review path.

## 2. Freeze the exact commit

The release must name a commit that already exists and has passed its checks.

```sh
git fetch origin main
release_commit="$(git rev-parse origin/main)"
printf '%s\n' "$release_commit"
```

Never tag a branch name, and never move a published tag. A defective release is
corrected by publishing a new patch version, not by rewriting an old one.

```sh
version="v1.10.1"
git tag -a "$version" "$release_commit" -m "OpenRappter $version"
git push origin "$version"
```

## 3. Publish with the GitHub CLI

`scripts/pinned-release.mjs` computes the installer hash from the commit's git
**blob** — not the working tree — so a stale checkout or a local line-ending
conversion cannot publish a digest for bytes that were never released.

Inspect the notes first:

```sh
node scripts/pinned-release.mjs notes --commit "$release_commit" --version "$version"
```

Then publish. The script refuses to run if the tag is missing or points at a
different commit, so a release can never describe code that was not tagged:

```sh
node scripts/pinned-release.mjs publish --commit "$release_commit" --version "$version"
```

This calls `gh release create --verify-tag` with source-only notes. Do not
attach binaries, `node_modules`, `dist/`, or an application assembled by an
installer.

Print the hashes alone at any time:

```sh
node scripts/pinned-release.mjs hashes --commit "$release_commit"
```

## 4. Verify the published release

On a clean machine, inspect the installer before executing it — this is the
whole point of publishing the hash:

```sh
commit=<full-40-char-sha>
curl -fsSL "https://raw.githubusercontent.com/kody-w/openrappter/$commit/install-pinned.sh" -o install-pinned.sh
shasum -a 256 install-pinned.sh        # must equal the release notes value
OPENRAPPTER_COMMIT="$commit" bash install-pinned.sh
```

The installer starts nothing; it writes a launcher and exits. Resolve a tag to
its commit with `gh` first if you prefer to name the release — annotated tags
must be dereferenced, or you pin the tag object rather than the commit:

```sh
sha=$(gh api repos/kody-w/openrappter/git/ref/tags/v1.11.0 --jq '.object.sha')
type=$(gh api repos/kody-w/openrappter/git/ref/tags/v1.11.0 --jq '.object.type')
[ "$type" = tag ] && sha=$(gh api "repos/kody-w/openrappter/git/tags/$sha" --jq '.object.sha')
OPENRAPPTER_COMMIT="$sha" bash install-pinned.sh
```

Confirm the installation reports the expected commit and a stamped CLI, then
exercise it headlessly (see `docs/AUTONOMOUS.md`).

## 5. What the installer guarantees

- **Commit-addressed source.** Downloaded from `codeload` at the exact commit,
  and its SHA-256 is recorded in the provenance file.
- **Verified toolchain.** A portable Node.js runtime is downloaded and checked
  against the official `SHASUMS256.txt` before it builds anything. Reuse of a
  cached runtime re-checks both the archive digest and the on-disk `node`.
- **Lockfile dependencies.** `npm ci`, never `npm install` — drift fails loudly
  instead of being silently resolved.
- **A stamped Copilot CLI.** `typescript/.openrappter-copilot-sha256` is written
  at build time and re-verified before any install is reused, so a binary
  swapped afterwards causes a rebuild rather than being executed.
- **A provenance record.** `.rapp-install.json` names the pin, the runtime, the
  lockfile digest, and the Copilot CLI that was installed.
- **Nothing global.** No `sudo`, no `npm -g`, no PATH edits. Uninstall is
  `rm -rf` of the install root.

## 6. Correcting a published release

Never silently replace an asset or move a tag.

- For incorrect notes, edit the notes and say what was corrected.
- For a defective installer or dependency, publish a new patch version.
- If an asset creates a security risk, remove it, keep an audit record, and
  publish corrected materials under a new version.
