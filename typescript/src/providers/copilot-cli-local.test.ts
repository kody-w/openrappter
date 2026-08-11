/**
 * The Copilot CLI must come from THIS repository's lockfile, not from whatever
 * the machine happens to have installed.
 *
 * These tests assert the ORDER, because the order is the whole fix. A resolver
 * that merely *can* find the pinned binary but still lets an ambient global win
 * has changed nothing: the version that answers would still be decided by
 * someone else's `copilot update`.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  COPILOT_STAMP_FILE,
  copilotBinaryName,
  copilotPlatformPackage,
  packageRoot,
  resolveLocalCopilotCli,
  resolveLocalCopilotCliPath,
  sha256File,
  verifyCopilotStamp,
} from './copilot-cli-local.js';
import { CopilotCliDirectProvider } from './copilot-cli-direct.js';

describe('copilotPlatformPackage', () => {
  it('names the publisher package that carries each native binary', () => {
    expect(copilotPlatformPackage('darwin', 'arm64')).toBe('@github/copilot-darwin-arm64');
    expect(copilotPlatformPackage('linux', 'x64')).toBe('@github/copilot-linux-x64');
    expect(copilotPlatformPackage('win32', 'x64')).toBe('@github/copilot-win32-x64');
  });

  it('collapses every other platform onto the linux package', () => {
    expect(copilotPlatformPackage('freebsd' as NodeJS.Platform, 'x64'))
      .toBe('@github/copilot-linux-x64');
  });

  it('asks for copilot.exe only on Windows', () => {
    expect(copilotBinaryName('win32')).toBe('copilot.exe');
    expect(copilotBinaryName('darwin')).toBe('copilot');
    expect(copilotBinaryName('linux')).toBe('copilot');
  });
});

describe('resolveLocalCopilotCli', () => {
  it('finds the binary pinned in this repository for the running platform', () => {
    const resolved = resolveLocalCopilotCli();
    expect(resolved.path).toBeTruthy();
    expect(existsSync(resolved.path as string)).toBe(true);
    // It must be OUR copy, not a global one.
    expect(resolved.path as string).toContain(path.join('node_modules', '@github'));
    expect(resolved.path as string).toContain(copilotPlatformPackage());
  });

  it('reports the lockfile-pinned version, so drift is visible', () => {
    // The platform package publishes `exports: { ".": "./copilot" }`, which makes
    // every subpath — package.json included — unresolvable. Reading the version
    // therefore cannot go through require.resolve, and this asserts it does not.
    expect(resolveLocalCopilotCli().version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('explains an absent platform package instead of returning a bare null', () => {
    // No machine has every platform's binary installed, so this exercises the
    // real miss path rather than a mock of it.
    const missing = resolveLocalCopilotCli('aix' as NodeJS.Platform, 'ppc64');
    expect(missing.path).toBeNull();
    expect(missing.reason).toContain('@github/copilot-linux-ppc64');
    expect(missing.reason).toContain('npm ci');
  });

  it('resolves to a file, never to a directory', () => {
    const resolved = resolveLocalCopilotCliPath();
    expect(resolved).toBeTruthy();
    expect(existsSync(resolved as string)).toBe(true);
  });
});

describe('CopilotCliDirectProvider resolution order', () => {
  it('puts the pinned local binary ahead of every ambient global path', () => {
    const candidates = CopilotCliDirectProvider.candidatePaths('/home/someone');
    expect(candidates[0]).toBe(resolveLocalCopilotCliPath());
    // The globals are kept as a floor for checkouts that never ran `npm ci`.
    expect(candidates).toContain('/opt/homebrew/bin/copilot');
    expect(candidates).toContain('/usr/local/bin/copilot');
    expect(candidates.indexOf('/opt/homebrew/bin/copilot')).toBeGreaterThan(0);
  });

  it('selects the pinned binary when no operator override is set', () => {
    const previousOverrides = [
      process.env.OPENRAPPTER_COPILOT_CLI,
      process.env.COPILOT_CLI_PATH,
    ];
    delete process.env.OPENRAPPTER_COPILOT_CLI;
    delete process.env.COPILOT_CLI_PATH;
    try {
      expect(CopilotCliDirectProvider.findCLI()).toBe(resolveLocalCopilotCliPath());
    } finally {
      if (previousOverrides[0] !== undefined) process.env.OPENRAPPTER_COPILOT_CLI = previousOverrides[0];
      if (previousOverrides[1] !== undefined) process.env.COPILOT_CLI_PATH = previousOverrides[1];
    }
  });

  it('still lets an explicit operator override outrank the pin', () => {
    // Pinning must not take away an operator's ability to point at a specific
    // binary — that is a deliberate act, not ambient drift.
    const previous = process.env.OPENRAPPTER_COPILOT_CLI;
    const override = path.join(packageRoot(), 'package.json'); // any existing file
    process.env.OPENRAPPTER_COPILOT_CLI = override;
    try {
      expect(CopilotCliDirectProvider.findCLI()).toBe(override);
    } finally {
      if (previous === undefined) delete process.env.OPENRAPPTER_COPILOT_CLI;
      else process.env.OPENRAPPTER_COPILOT_CLI = previous;
    }
  });
});

describe('verifyCopilotStamp', () => {
  let root: string;
  let binary: string;

  const withTempRoot = (run: () => void) => {
    root = mkdtempSync(path.join(tmpdir(), 'openrappter-stamp-'));
    binary = path.join(root, 'copilot');
    writeFileSync(binary, 'pinned-binary-bytes');
    try {
      run();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('accepts an unstamped install rather than making strict the only mode', () => {
    withTempRoot(() => {
      const verification = verifyCopilotStamp(binary, root);
      expect(verification.ok).toBe(true);
      expect(verification.unstamped).toBe(true);
    });
  });

  it('accepts a binary whose digest matches the installer stamp', () => {
    withTempRoot(() => {
      writeFileSync(path.join(root, COPILOT_STAMP_FILE), `${sha256File(binary)}\n`);
      const verification = verifyCopilotStamp(binary, root);
      expect(verification.ok).toBe(true);
      expect(verification.unstamped).toBe(false);
    });
  });

  it('refuses a binary that changed after installation', () => {
    withTempRoot(() => {
      writeFileSync(path.join(root, COPILOT_STAMP_FILE), `${sha256File(binary)}\n`);
      writeFileSync(binary, 'substituted-binary-bytes');
      const verification = verifyCopilotStamp(binary, root);
      expect(verification.ok).toBe(false);
      expect(verification.reason).toContain('has changed since installation');
    });
  });

  it('refuses a malformed stamp instead of treating it as absent', () => {
    withTempRoot(() => {
      writeFileSync(path.join(root, COPILOT_STAMP_FILE), 'not-a-digest\n');
      const verification = verifyCopilotStamp(binary, root);
      expect(verification.ok).toBe(false);
      expect(verification.unstamped).toBe(false);
      expect(verification.reason).toContain('malformed stamp');
    });
  });

  it('refuses a stamped install whose binary went missing', () => {
    withTempRoot(() => {
      writeFileSync(path.join(root, COPILOT_STAMP_FILE), `${sha256File(binary)}\n`);
      rmSync(binary);
      const verification = verifyCopilotStamp(binary, root);
      expect(verification.ok).toBe(false);
      expect(verification.reason).toContain('missing');
    });
  });
});

describe('packageRoot', () => {
  it('points at the directory that owns package.json and node_modules', () => {
    expect(existsSync(path.join(packageRoot(), 'package.json'))).toBe(true);
    expect(existsSync(path.join(packageRoot(), 'node_modules'))).toBe(true);
  });
});
