import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * No test file may be added that cannot fail.
 *
 * A test that imports no product code and reads no real artifact is asserting
 * literals against themselves. It passes whatever the product does, and it
 * still reports as a passing test, so the suite total overstates what is
 * actually covered.
 *
 * This is not hypothetical here. `parity/security.test.ts` used to be one of
 * these. Inverting `ApprovalManager.checkApproval` so that a tool *not* on the
 * allowlist becomes `allowed: true` — a real privilege escalation — left that
 * suite at 20 passed. The rewrite in #210 catches it with 4 failures. #213
 * then rewrote or removed eight more.
 *
 * Rewriting the rest is worth doing, but on its own it fixes only the
 * instances. This guard closes the class: `KNOWN_INERT` may shrink and may
 * never grow, so the remaining debt is visible and no new inert file can be
 * added without deliberately editing this list.
 *
 * Being listed here is not an accusation that a file is worthless — some are
 * specifications with no product unit yet to point at. It means the file
 * cannot currently fail, and should not be counted as coverage.
 */
const KNOWN_INERT = new Set([
  // Catalogued by the #213 audit as having no product unit to target, or
  // wrapping external I/O that is mocked end to end.
  'src/__tests__/parity/advanced.test.ts',
  'src/__tests__/parity/browser.test.ts',
  'src/__tests__/parity/media.test.ts',
  'src/__tests__/parity/multiagent.test.ts',
  'src/__tests__/parity/network.test.ts',
  'src/__tests__/parity/onboarding.test.ts',
  'src/__tests__/parity/power-prompts-2.test.ts',
  'src/__tests__/parity/power-prompts.test.ts',
  'src/__tests__/parity/voice.test.ts',

  // Not parity specs. These sit beside the module they are named after, which
  // makes them likelier to be trusted than the parity suites ever were.
  //   schema.test.ts     — 23 blocks beside config/schema.ts, all literals
  //   providers.test.ts  — 8 blocks beside the provider registry
  //   imessage-channel   — 21 blocks over a privacy-sensitive channel
  'src/config/schema.test.ts',
  'src/providers/providers.test.ts',
  'src/__tests__/imessage-channel.test.ts',
]);

/** Every test file in the TypeScript package. */
function testFiles(dir = srcRoot, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testFiles(full, found);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Whether a test file reaches the product at all.
 *
 * Two ways count, because both are used in this repo and only one is an
 * `import`: a relative import of a module, or reading/running a real artifact.
 * `install-ps1-gateway.test.ts` runs the CLI through `execFile` and imports
 * nothing but `vitest`; `cli-flags.test.ts` reads `index.ts` off disk. Neither
 * is inert, and a detector that looked only at imports would call both dead.
 */
function reachesProduct(source: string): boolean {
  const relativeImport = /^\s*import\s[\s\S]*?from\s+['"][^'"]*\.[./][^'"]*['"]/m.test(source);
  const dynamicAccess = /await\s+import\(|\brequire\(|\bexecFile|\bexecSync|\bspawn|\breadFile|\bcreateRequire|\bfetch\(/.test(source);
  return relativeImport || dynamicAccess;
}

function relative(file: string): string {
  return path.relative(path.resolve(srcRoot, '..'), file).split(path.sep).join('/');
}

describe('no test file may be added that cannot fail', () => {
  const files = testFiles();

  it('scans a realistic number of test files', () => {
    // Anti-vacuity: a broken walker would make every assertion below pass by
    // having nothing to look at — which is the exact failure being guarded.
    expect(files.length).toBeGreaterThan(200);
  });

  it('recognises both ways a test reaches the product', () => {
    // Detector control. If `reachesProduct` returned false for everything, the
    // inert set would swallow the whole suite; if it returned true for
    // everything, the guard would never fire again.
    expect(reachesProduct("import { thing } from '../../agents/BasicAgent.js';")).toBe(true);
    expect(reachesProduct("const out = await execFile(cli, ['--help']);")).toBe(true);
    expect(reachesProduct("const src = await fs.readFile(entry, 'utf-8');")).toBe(true);
    expect(reachesProduct("import { describe, it, expect } from 'vitest';")).toBe(false);
  });

  it('adds no new test file that never touches the product', () => {
    const inert = files
      .filter((file) => !reachesProduct(fs.readFileSync(file, 'utf8')))
      .map(relative)
      .sort();

    const added = inert.filter((file) => !KNOWN_INERT.has(file));

    expect(
      added,
      added.length
        ? `These test files import no product code and read no real artifact, so they\n` +
          `cannot fail and must not be counted as coverage:\n\n` +
          added.map((f) => `  ${f}`).join('\n') +
          `\n\nPoint them at real code, or if they are a specification with nothing to\n` +
          `target yet, add them to KNOWN_INERT with a reason.\n`
        : '',
    ).toEqual([]);
  });

  it('keeps KNOWN_INERT free of entries that no longer apply', () => {
    // The list may only shrink. A stale entry would quietly re-permit a file
    // that has since been fixed — the same rot that let the parity suites sit
    // for so long.
    const inert = new Set(
      files
        .filter((file) => !reachesProduct(fs.readFileSync(file, 'utf8')))
        .map(relative),
    );

    const stale = [...KNOWN_INERT].filter((file) => !inert.has(file)).sort();
    expect(
      stale,
      stale.length ? `No longer inert (or moved) — remove from KNOWN_INERT:\n${stale.join('\n')}` : '',
    ).toEqual([]);
  });
});
