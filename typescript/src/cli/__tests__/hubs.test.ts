/**
 * Locating the Python runtime the hub commands delegate to.
 *
 * A half-install is the case that matters: an interpreter with no sources
 * cannot import `openrappter.cli`, and delegating to it would surface a
 * ModuleNotFoundError about a package the user never named. Both halves or
 * nothing.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findPythonRuntime } from '../hubs.js';

function makeHome(parts: { sources?: boolean; venv?: boolean }): string {
  const home = mkdtempSync(join(tmpdir(), 'openrappter-hubs-'));
  if (parts.sources) {
    mkdirSync(join(home, 'python', 'openrappter'), { recursive: true });
    writeFileSync(join(home, 'python', 'openrappter', 'cli.py'), '');
  }
  if (parts.venv) {
    mkdirSync(join(home, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(home, '.venv', 'bin', 'python'), '');
  }
  return home;
}

describe('findPythonRuntime', () => {
  it('finds a complete install', () => {
    const home = makeHome({ sources: true, venv: true });
    try {
      const runtime = findPythonRuntime(home);
      expect(runtime).not.toBeNull();
      expect(runtime?.python).toBe(join(home, '.venv', 'bin', 'python'));
      expect(runtime?.cwd).toBe(join(home, 'python'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects an interpreter with no sources to import', () => {
    const home = makeHome({ venv: true });
    try {
      expect(findPythonRuntime(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects sources with no interpreter', () => {
    const home = makeHome({ sources: true });
    try {
      expect(findPythonRuntime(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports nothing for an empty home', () => {
    const home = makeHome({});
    try {
      expect(findPythonRuntime(home)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
