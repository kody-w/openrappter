/**
 * The GitHub Copilot CLI, resolved out of THIS repository's own `node_modules`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now every Copilot CLI lookup in openrappter ended at an ambient,
 * machine-wide path: `/opt/homebrew/bin/copilot`, `/usr/local/bin/copilot`,
 * VS Code's `globalStorage`, or whatever `command -v copilot` happened to
 * answer. That makes the single most important dependency in the product —
 * the thing that actually thinks — an unpinned global whose version is
 * decided by someone else's `copilot update`, and whose bytes nobody checked.
 * Two machines on the same openrappter commit could run different CLIs, and
 * "which binary answered" would silently become a behavioural fact.
 *
 * The local-repo pattern closes that: `@github/copilot` is a lockfile-pinned
 * dependency, so the CLI arrives with the source commit, at a known version,
 * from its publisher. Resolution prefers that copy, and an installer that
 * stamped a SHA-256 can have it re-verified on every start — a changed binary
 * is refused rather than run.
 *
 * RESOLUTION ORDER (deliberate, and asserted in tests)
 * ----------------------------------------------------
 *   1. an explicit operator override (`OPENRAPPTER_COPILOT_CLI`/`COPILOT_CLI_PATH`)
 *   2. this repository's pinned `node_modules` copy
 *   3. ambient global installs
 *
 * The override stays on top because an operator pointing at a specific binary
 * is a deliberate act. The pinned copy beats the globals because it is the one
 * that shipped with this commit. The globals remain last so a machine that
 * never ran `npm ci` still works — this is a floor, never a hard requirement.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Anchored to THIS file rather than to the process CWD or the bundle location.
 *
 * `dist/providers/copilot-cli-local.js` and `src/providers/copilot-cli-local.ts`
 * both sit two directories below the package root, so a require anchored here
 * walks up into the package's own `node_modules` from either one. Anchoring to
 * `process.cwd()` would instead resolve against whatever directory the daemon
 * happened to be started from, which is exactly the ambient-lookup bug this
 * module exists to remove.
 */
const localRequire = createRequire(import.meta.url);

/** The npm package that carries the native binary for this platform+arch. */
export function copilotPlatformPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  return `@github/copilot-${os}-${arch}`;
}

/** The executable's file name on this platform. */
export function copilotBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'copilot.exe' : 'copilot';
}

export interface LocalCopilotResolution {
  /** Absolute path to the pinned CLI, or null when this repo has no local copy. */
  path: string | null;
  /** The pinned package version, when it could be read. */
  version?: string;
  /** Why resolution failed, for `doctor` to print instead of a bare null. */
  reason?: string;
}

/**
 * Resolve the pinned CLI shipped in this repository's `node_modules`.
 *
 * Returns a structured result rather than throwing: a missing local copy is an
 * ordinary state (nobody has run `npm ci` yet), not a fault. Callers fall back
 * to the ambient globals.
 *
 * Note the deliberate avoidance of `require.resolve(pkg + '/package.json')`.
 * The platform package publishes `"exports": { ".": "./copilot" }`, which makes
 * every subpath — including `package.json` — unresolvable. A resolver written
 * against that subpath silently loses both the version and its fallback branch,
 * so directory lookup is done on the filesystem instead.
 */
export function resolveLocalCopilotCli(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): LocalCopilotResolution {
  const packageName = copilotPlatformPackage(platform, arch);
  const binaryName = copilotBinaryName(platform);

  // `exports` maps "." straight at the binary in current releases, so this is
  // the fast path. It is still not trusted without an existsSync.
  try {
    const resolved = localRequire.resolve(packageName);
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return { path: resolved, version: readPinnedVersion(path.dirname(resolved)) };
    }
  } catch {
    // Not installed, or `exports` forbids the bare specifier — walk node_modules.
  }

  // Filesystem walk over the same node_modules directories Node would search.
  // Immune to whatever the package's `exports` map does or does not allow.
  for (const directory of nodeModulesCandidates(packageName)) {
    const binary = path.join(directory, binaryName);
    if (existsSync(binary)) {
      return { path: binary, version: readPinnedVersion(directory) };
    }
    if (existsSync(directory)) {
      return {
        path: null,
        reason: `${packageName} is installed but contains no ${binaryName}`,
      };
    }
  }

  return {
    path: null,
    reason: `${packageName} is not installed — run \`npm ci\` in typescript/ to pin the Copilot CLI locally`,
  };
}

/** Every `node_modules/<packageName>` directory Node would consider, nearest first. */
function nodeModulesCandidates(packageName: string): string[] {
  const roots = localRequire.resolve.paths(packageName) ?? [];
  return roots.map((root) => path.join(root, ...packageName.split('/')));
}

/** Convenience wrapper for callers that only want the path. */
export function resolveLocalCopilotCliPath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  return resolveLocalCopilotCli(platform, arch).path;
}

function readPinnedVersion(packageDirectory: string): string | undefined {
  try {
    const manifest = path.join(packageDirectory, 'package.json');
    const parsed = JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: string };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** SHA-256 of a file, lowercase hex — the same digest the installer stamps. */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * The provenance stamp a commit-pinned install writes next to its source tree.
 *
 * `install-pinned.sh` records the CLI's digest at build time. Re-checking it
 * here is what makes the pin tamper-evident at RUN time too: without this, a
 * binary swapped after installation would still be executed, and the pin would
 * only ever have been a claim about the past.
 */
export const COPILOT_STAMP_FILE = '.openrappter-copilot-sha256';

export interface StampVerification {
  ok: boolean;
  /** True when no stamp exists — an unstamped install is allowed, not failed. */
  unstamped: boolean;
  expected?: string;
  actual?: string;
  reason?: string;
}

/**
 * Verify a resolved CLI against the stamp written by the pinned installer.
 *
 * An absent stamp is NOT a failure: development checkouts and npm installs are
 * legitimately unstamped, and refusing them would make the strict path the only
 * path. A present stamp that disagrees IS a failure, because the only ways to
 * reach it are a corrupted download or a substituted binary.
 */
export function verifyCopilotStamp(
  binaryPath: string,
  installRoot: string,
): StampVerification {
  const stampPath = path.join(installRoot, COPILOT_STAMP_FILE);
  if (!existsSync(stampPath)) {
    return { ok: true, unstamped: true };
  }
  const expected = readFileSync(stampPath, 'utf-8').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, unstamped: false, reason: `malformed stamp in ${stampPath}` };
  }
  if (!existsSync(binaryPath)) {
    return { ok: false, unstamped: false, expected, reason: `stamped CLI is missing: ${binaryPath}` };
  }
  const actual = sha256File(binaryPath);
  return actual === expected
    ? { ok: true, unstamped: false, expected, actual }
    : {
        ok: false,
        unstamped: false,
        expected,
        actual,
        reason:
          'the pinned GitHub Copilot CLI has changed since installation — '
          + 're-run the pinned installer rather than trusting this binary',
      };
}

/**
 * The package root of this installation, i.e. the directory holding
 * `package.json` and `node_modules`. Used to find the installer's stamp.
 */
export function packageRoot(): string {
  // …/<root>/dist/providers/x.js and …/<root>/src/providers/x.ts both resolve up two.
  // fileURLToPath, not `new URL(...).pathname`: the latter keeps a leading slash
  // on Windows drive paths ("/C:/…") and percent-encodes spaces, so an install
  // under "Application Support" would resolve to a directory that does not exist.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
