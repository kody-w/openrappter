/**
 * `OPENRAPPTER_HOME` is a documented way to relocate the data directory
 * (README), and it was honoured in 4 places while 46 others spelled
 * `path.join(os.homedir(), '.openrappter')` inline.
 *
 * The consequence was not "the variable is ignored" -- it was worse than
 * that. Setting it *half-moved* an installation: the invocation journal, hubs
 * and the iMessage proxy followed it, while sessions, config, backups, the
 * gateway lock, audit config and pairing stayed in `~/.openrappter`. A backup
 * taken in that state silently omits whatever moved, and `doctor` reports on a
 * directory the runtime may not be using.
 *
 * Every site now resolves through `openrappterHome()`. This guard fails if a
 * new one is written inline, because a single straggler re-creates the split.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, join } from 'path';
import { openrappterHome, openrappterPath } from '../../infra/openrappter-home.js';

const SRC = resolve(__dirname, '../..');
const HELPER = join(SRC, 'infra/openrappter-home.ts');

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

describe('openrappterHome', () => {
  const original = process.env.OPENRAPPTER_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENRAPPTER_HOME;
    else process.env.OPENRAPPTER_HOME = original;
  });

  it('uses the override when set', () => {
    process.env.OPENRAPPTER_HOME = '/tmp/somewhere-else';
    expect(openrappterHome()).toBe('/tmp/somewhere-else');
    expect(openrappterPath('agents')).toBe('/tmp/somewhere-else/agents');
  });

  it('falls back to ~/.openrappter when unset', () => {
    delete process.env.OPENRAPPTER_HOME;
    expect(openrappterHome()).toMatch(/\.openrappter$/);
  });

  it('ignores an empty or whitespace override', () => {
    // An exported-but-empty variable is a common shell accident, and treating
    // it as a real path would relocate the whole install to the filesystem
    // root or to a relative directory.
    process.env.OPENRAPPTER_HOME = '   ';
    expect(openrappterHome()).toMatch(/\.openrappter$/);
  });

  it('reads the variable at call time, not at import time', () => {
    // `openrappter reset` and the test suite both change this after modules
    // are loaded. A captured module-level constant would keep pointing at the
    // directory that was current when the file happened to be imported.
    process.env.OPENRAPPTER_HOME = '/tmp/first';
    expect(openrappterHome()).toBe('/tmp/first');
    process.env.OPENRAPPTER_HOME = '/tmp/second';
    expect(openrappterHome()).toBe('/tmp/second');
  });
});

describe('no source file hardcodes the data directory', () => {
  it('scans a meaningful number of files', () => {
    // Guard the guard: a broken walk would make the assertion below vacuous.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('gateway/server.ts'))).toBe(true);
  });

  it('every path to the data directory goes through the helper', () => {
    const offenders = sourceFiles()
      .filter((f) => f !== HELPER)
      // Whitespace-tolerant, including newlines: `flight-recorder/recorder.ts`
      // spelled the same path across three lines and the original single-line
      // pattern walked straight past it, so this guard reported zero
      // offenders while one remained. A regex that cannot see the formatting
      // it is policing is the shape this file exists to prevent.
      .filter((f) =>
        /homedir\(\)\s*,\s*["']\.openrappter["']/.test(readFileSync(f, 'utf-8')),
      )
      .map((f) => relative(SRC, f))
      .sort();

    // Was 46. The helper itself is the one legitimate place.
    expect(offenders).toEqual([]);
  });
});
