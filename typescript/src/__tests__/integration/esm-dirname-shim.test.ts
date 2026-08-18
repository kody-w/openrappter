/**
 * `__dirname` does not exist in ESM, and this package is ESM ("type": "module").
 *
 * Using the bare identifier compiles cleanly -- @types/node declares it, so tsc
 * is happy -- and then throws `ReferenceError: __dirname is not defined` the
 * first time the enclosing function runs. Nothing catches it earlier: the
 * failure needs the *statement* to execute, so a module can import fine and
 * blow up only when a specific command is invoked.
 *
 * That is exactly what happened to `infra/channel.ts`: `detectRepoDir` used a
 * bare `__dirname`, so `openrappter channel status` -- a live, registered,
 * user-facing command -- failed on every run with that ReferenceError, while
 * `channel promote` (which never reaches that line) worked. Four other files
 * already defined the shim; this one was missed.
 *
 * These tests pin the rule for every source file, so the next module to reach
 * for `__dirname` cannot ship the same latent throw.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, relative, join } from 'path';

const SRC = resolve(__dirname, '../..');

/** Source files, excluding tests (vitest runs those as CJS-ish, shim not needed). */
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

/** A file "defines" __dirname if it assigns it, rather than only reading it. */
function definesDirname(text: string): boolean {
  return /(?:const|let|var)\s+__dirname\s*=/.test(text);
}

function usesDirname(text: string): boolean {
  // Strip line comments so a doc-comment mentioning __dirname is not a "use".
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return /\b__dirname\b/.test(code);
}

describe('ESM __dirname shim', () => {
  it('finds a meaningful number of source files', () => {
    // Guard the guard: a broken glob would make every assertion below vacuous.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('infra/channel.ts'))).toBe(true);
  });

  it('every source file that uses __dirname also defines it', () => {
    const offenders = sourceFiles()
      .filter((f) => {
        const text = readFileSync(f, 'utf-8');
        return usesDirname(text) && !definesDirname(text);
      })
      .map((f) => relative(SRC, f))
      .sort();

    expect(offenders).toEqual([]);
  });

  it('infra/channel.ts resolves a repo dir instead of throwing', () => {
    // The behavioural half: the regression was only observable by running the
    // code path, which no test did. channelStatus() reaches detectRepoDir().
    const text = readFileSync(resolve(SRC, 'infra/channel.ts'), 'utf-8');
    expect(text).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    expect(definesDirname(text)).toBe(true);
  });
});
