# Releasing OpenRappter

OpenRappter follows Skill Recorder's source-only release pattern:

1. Publish an immutable annotated tag after the staging commit passes.
2. Record the full release commit and installer hashes in the GitHub Release.
3. Do not attach locally assembled Electron applications to the source release.
4. Test the installer against the exact commit from a clean isolated home.

Local Electron packaging is currently supported only for macOS ARM64 acceptance
evidence. Windows and Linux distributable targets remain disabled until
target-native ffmpeg/ffprobe hashes and builders are pinned. Local ZIP/DMG
artifacts are development-signed, not notarized, and **must not** be attached to
the source release; ordinary users install through the source installer.

## 1. Prepare and validate

Update `VERSION`, `package.json`, and `package-lock.json` to the same semantic
prerelease version, then run:

```sh
npm ci --no-audit --no-fund
npm run check
npm test
```

Wait for the repository preflight workflow on the release commit to pass.

Binary packaging is optional and is not required for a source-only release. If
you intentionally prepare a macOS preview artifact, run `npm run dist:mac` and
review it separately. Do not attach a locally assembled application to the
source-only GitHub Release.

## 2. Create the immutable tag

Use a component-qualified tag because this repository ships more than one
versioned product:

```sh
version="0.1.0-beta.1"
release_commit="<full-40-character-commit>"
tag="brainstem-beta-v$version"
git tag -a "$tag" "$release_commit" -m "OpenRappter v$version"
git push upstream "$tag"
```

Never move or reuse a published tag. Publish a new prerelease version instead.

The in-app updater installs **only** the commit behind this annotated tag. Until
the tag exists, a bumped `beta/VERSION` on the branch is reported to users as
"staged, not released"; a lightweight tag or a tag whose `beta/VERSION` disagrees
with the branch is refused. The updater also stages the installed commit's own
installer as a rollback before anything moves, so a failed update re-installs
the previous version instead of leaving a launcher that cannot open.

## 3. Calculate installer hashes

Calculate hashes from the exact release commit's Git blobs:

```sh
node -e 'const {execFileSync}=require("node:child_process");const {createHash}=require("node:crypto");const commit=process.argv[1];if(!/^[0-9a-f]{40}$/i.test(commit))throw new Error("full release commit SHA required");for(const file of ["beta/install.cmd","beta/install.sh"]){const data=execFileSync("git",["cat-file","blob",commit+":"+file]);console.log(createHash("sha256").update(data).digest("hex")+"  "+file)}' "$release_commit"
```

## 4. Publish the source-only prerelease

Release notes must include:

- the version and full release commit;
- SHA-256 values for `beta/install.cmd` and `beta/install.sh`;
- user-visible changes and known beta limitations;
- commit-pinned Windows and macOS/Linux install commands;
- a clear statement that the release is source-only.

Publish after preparing a temporary notes file outside the repository:

```sh
gh release create "$tag" \
  --repo microsoft/aibast-agents-library \
  --verify-tag \
  --prerelease \
  --title "OpenRappter v$version" \
  --notes-file "<release-notes-file>"
```

## 5. Test the published commit

Use a clean temporary `HOME` and disable launch during installation:

```sh
repo="microsoft/aibast-agents-library"
commit="<full-40-character-commit>"
curl -fsSL "https://raw.githubusercontent.com/$repo/$commit/beta/install.sh" \
  | HOME="<isolated-home>" \
    BRAINSTEM_BETA_HOME="<isolated-home>/.brainstem/beta-launcher" \
    BRAINSTEM_BETA_REPO_URL="https://github.com/$repo.git" \
    BRAINSTEM_BETA_COMMIT="$commit" \
    BRAINSTEM_BETA_NO_LAUNCH=1 bash
```

Confirm the launcher checkout and the shared Brainstem checkout both resolve to
the release commit, then launch the installed Electron application and verify
the Brainstem health endpoint.
