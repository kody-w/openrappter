/**
 * Nothing may freeze the data directory at import time.
 *
 * `openrappterHome()` reads `OPENRAPPTER_HOME` on every call, deliberately:
 * `openrappter reset` and the test suite both change it after modules are
 * loaded, and its own doc-comment says a captured constant "would silently
 * keep pointing at the old directory".
 *
 * The migration in #331 then created nine module-level constants that did
 * exactly that. It was invisible until an audit test set `OPENRAPPTER_HOME`,
 * pointed the auditor at a temp installation with a deliberately exposed
 * gateway, and got **no findings** -- because `getConfigPath()` was still
 * resolving against the directory captured when the module first loaded.
 *
 * Before that migration these constants froze `join(homedir(), '.openrappter')`,
 * which is effectively constant, so the capture was harmless. Making the value
 * env-dependent is what turned a stylistic detail into a bug.
 *
 * The three entries below are exported and read in 43 places; converting them
 * is a separate change. This list is shrink-only -- it exists so the count
 * goes down and never up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, join } from 'path';

const SRC = resolve(__dirname, '../..');

/** Exported captures that predate this guard. Shrink-only. */
const KNOWN_FROZEN = new Set([
  'agents/workspace.ts',
  'env.ts',
  'telephony/watcher.ts',
]);

function sourceFiles(dir: string = SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Module-level `const X = openrappterHome()` / `openrappterPath(...)`. */
const FROZEN = /^(?:export )?const\s+\w+\s*=\s*openrappter(?:Home|Path)\(/m;

describe('the data directory is resolved at call time', () => {
  it('scans a meaningful number of files', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('config/loader.ts'))).toBe(true);
  });

  it('no new module-level capture appears', () => {
    const offenders = sourceFiles()
      .filter((f) => FROZEN.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f))
      .filter((f) => !KNOWN_FROZEN.has(f))
      .sort();

    // Was nine. `config/loader.ts` was the one that actually bit.
    expect(offenders).toEqual([]);
  });

  it('the known list has not grown', () => {
    // Guard the guard: if the regex stopped matching, the check above would
    // pass vacuously, so assert the known offenders are still detected.
    const stillFrozen = [...KNOWN_FROZEN].filter((f) =>
      FROZEN.test(readFileSync(join(SRC, f), 'utf-8')),
    );
    expect(stillFrozen.sort()).toEqual([...KNOWN_FROZEN].sort());
  });

  it('getConfigPath follows OPENRAPPTER_HOME after import', async () => {
    // The behaviour, not just the shape. This is what the audit tests needed
    // and did not get.
    const { getConfigPath } = await import('../../config/loader.js');
    const saved = process.env.OPENRAPPTER_HOME;
    try {
      process.env.OPENRAPPTER_HOME = '/tmp/first-home';
      expect(getConfigPath()).toBe('/tmp/first-home/config.json5');
      process.env.OPENRAPPTER_HOME = '/tmp/second-home';
      expect(getConfigPath()).toBe('/tmp/second-home/config.json5');
    } finally {
      if (saved === undefined) delete process.env.OPENRAPPTER_HOME;
      else process.env.OPENRAPPTER_HOME = saved;
    }
  });
});
