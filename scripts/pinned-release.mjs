#!/usr/bin/env node
/**
 * Prepare and publish a commit-pinned, source-only OpenRappter release.
 *
 * WHY A SCRIPT AND NOT A CHECKLIST
 * --------------------------------
 * The two things a pinned release promises are (1) that the tag names an exact
 * commit and (2) that the installer a user downloads is the installer we
 * reviewed. Both are easy to get subtly wrong by hand:
 *
 *   · hashing the WORKING TREE instead of the commit's git blob publishes a
 *     digest for bytes that were never released — a stale checkout or a local
 *     CRLF conversion is enough to make the published hash unverifiable;
 *   · tagging a branch name rather than a resolved SHA means the release can
 *     silently describe different code later.
 *
 * So this reads blobs out of the object database with `git cat-file`, and it
 * refuses anything that is not a full 40-character commit.
 *
 * USAGE
 *   node scripts/pinned-release.mjs notes  --commit <sha> [--version v1.10.1]
 *   node scripts/pinned-release.mjs hashes --commit <sha>
 *   node scripts/pinned-release.mjs publish --commit <sha> --version v1.10.1 [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parsePackageReleaseTag } from './release-preflight.mjs';

const REPOSITORY = process.env.OPENRAPPTER_REPOSITORY ?? 'kody-w/openrappter';
const INSTALLER_FILES = ['install-pinned.sh'];

function fail(message) {
  process.stderr.write(`[pinned-release] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...options }).trim();
}

/** Resolve and hard-validate the release commit. */
function resolveCommit(input) {
  if (!input || input === true) fail('--commit is required.');
  if (!/^[0-9a-f]{40}$/i.test(input)) {
    // Deliberately strict. A short SHA or a branch name would still resolve
    // locally while naming something different on another machine.
    fail(`--commit must be a full 40-character SHA; got '${input}'.`);
  }
  const commit = input.toLowerCase();
  let type;
  try {
    type = git(['cat-file', '-t', commit]);
  } catch {
    fail(`commit ${commit} does not exist in this repository.`);
  }
  if (type !== 'commit') fail(`${commit} is a ${type}, not a commit.`);
  return commit;
}

/**
 * SHA-256 of each installer, read from the commit's blob rather than from disk.
 * This is the number a user compares against before piping a script to bash.
 */
function installerHashes(commit) {
  return INSTALLER_FILES.map((file) => {
    let blob;
    try {
      blob = execFileSync('git', ['cat-file', 'blob', `${commit}:${file}`], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      fail(`${file} does not exist at commit ${commit}.`);
    }
    return { file, sha256: createHash('sha256').update(blob).digest('hex') };
  });
}

function readVersionAtCommit(commit) {
  try {
    const blob = execFileSync('git', ['cat-file', 'blob', `${commit}:typescript/package.json`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(blob).version;
  } catch {
    return undefined;
  }
}

function buildNotes(commit, version) {
  const hashes = installerHashes(commit);
  const packageVersion = readVersionAtCommit(commit);
  const hashLines = hashes.map((h) => `- \`${h.file}\` — \`${h.sha256}\``).join('\n');
  const subject = git(['log', '-1', '--format=%s', commit]);

  return `OpenRappter ${version} — source-only, commit-pinned.

**Release commit:** \`${commit}\`
**Package version:** \`${packageVersion ?? 'unknown'}\`
**Head commit subject:** ${subject}

This release is **source-only**. No binaries are attached. The installer builds
OpenRappter locally from this exact commit and downloads no prebuilt
application.

## Install

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/${REPOSITORY}/${commit}/install-pinned.sh -o install-pinned.sh
shasum -a 256 install-pinned.sh   # compare with the hash below
OPENRAPPTER_COMMIT=${commit} bash install-pinned.sh
\`\`\`

The installer refuses anything that is not an exact 40-character commit, starts
nothing, and installs nothing globally. Uninstalling is \`rm -rf\` of the install
root.

## Installer SHA-256

${hashLines}

Hashes are computed from this commit's git blobs, so they describe exactly the
bytes GitHub serves for this tag.

## What a pinned install guarantees

- The source tree is the one at \`${commit}\`, and its archive digest is recorded.
- Dependencies come from \`npm ci\` against the committed lockfile.
- The **GitHub Copilot CLI is a lockfile-pinned local dependency**, not an
  ambient global. Its SHA-256 is stamped at build time and re-verified before an
  existing install is reused, so a binary replaced afterwards forces a rebuild
  instead of being executed.
- A \`.rapp-install.json\` provenance record names the pin, the Node runtime, the
  lockfile digest, and the Copilot CLI.
`;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || command === 'help') {
  process.stdout.write(
    'Usage:\n'
    + '  node scripts/pinned-release.mjs hashes  --commit <sha>\n'
    + '  node scripts/pinned-release.mjs notes   --commit <sha> --version <vX.Y.Z[-PRERELEASE]>\n'
    + '  node scripts/pinned-release.mjs publish --commit <sha> --version <vX.Y.Z[-PRERELEASE]> [--dry-run]\n',
  );
  process.exit(command ? 0 : 1);
}

const commit = resolveCommit(args.commit);

if (command === 'hashes') {
  for (const { file, sha256 } of installerHashes(commit)) {
    process.stdout.write(`${sha256}  ${file}\n`);
  }
  process.exit(0);
}

const version = typeof args.version === 'string' ? args.version : undefined;
if (!version) fail('--version is required (e.g. --version v1.10.1).');
try {
  parsePackageReleaseTag(version);
} catch (error) {
  fail(error.message);
}

if (command === 'notes') {
  process.stdout.write(buildNotes(commit, version));
  process.exit(0);
}

if (command !== 'publish') fail(`unknown command '${command}'.`);

// ── publish ──────────────────────────────────────────────────────────────────
const notes = buildNotes(commit, version);
const workDir = mkdtempSync(path.join(tmpdir(), 'openrappter-release-'));
const notesFile = path.join(workDir, 'release-notes.md');
writeFileSync(notesFile, notes);

try {
  if (args['dry-run']) {
    process.stdout.write(notes);
    process.stdout.write(`\n[pinned-release] dry run — would publish ${version} at ${commit}\n`);
    process.exit(0);
  }

  // The tag must already exist and point at this commit. Creating it here would
  // let a release be published for a commit whose CI never ran.
  let taggedCommit;
  try {
    taggedCommit = git(['rev-list', '-n', '1', version]);
  } catch {
    fail(`tag ${version} does not exist. Create and push it first:\n`
      + `  git tag -a ${version} ${commit} -m "OpenRappter ${version}"\n`
      + `  git push origin ${version}`);
  }
  if (taggedCommit !== commit) {
    fail(`tag ${version} points at ${taggedCommit}, not ${commit}.`);
  }

  execFileSync('gh', [
    'release', 'create', version,
    '--repo', REPOSITORY,
    '--verify-tag',
    '--title', `OpenRappter ${version}`,
    '--notes-file', notesFile,
  ], { stdio: 'inherit' });

  process.stdout.write(`[pinned-release] published ${version} at ${commit}\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
