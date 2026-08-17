import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = path.resolve(packageRoot, '..');

/**
 * The roots that ship tests.
 *
 * The UI is a separate package with its own vitest run, and the first version
 * of this guard scanned only `typescript/src` — the same narrowness that #199,
 * #200 and #201 each had to correct in an earlier guard of mine. A rule that
 * covers one package of two is not a rule.
 */
const TEST_ROOTS = [
  path.join(packageRoot, 'src'),
  path.join(repoRoot, 'typescript', 'ui', 'src'),
].filter((dir) => fs.existsSync(dir));

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
  'typescript/src/__tests__/parity/advanced.test.ts',
  'typescript/src/__tests__/parity/browser.test.ts',
  'typescript/src/__tests__/parity/media.test.ts',
  'typescript/src/__tests__/parity/multiagent.test.ts',
  'typescript/src/__tests__/parity/network.test.ts',
  'typescript/src/__tests__/parity/onboarding.test.ts',
  'typescript/src/__tests__/parity/power-prompts-2.test.ts',
  'typescript/src/__tests__/parity/power-prompts.test.ts',
  'typescript/src/__tests__/parity/voice.test.ts',
  // Three former entries — src/config/schema.test.ts, src/providers/providers.test.ts
  // and src/__tests__/imessage-channel.test.ts — were deleted rather than
  // catalogued: each was already covered by a real suite (parity/config*.test.ts
  // + unit/config-ignored-keys.test.ts; parity/providers.test.ts;
  // channels/imessage.test.ts respectively). Removing them keeps this list
  // shrink-only.
]);

/** Every test file in the TypeScript and UI packages. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (/\.test\.[tj]sx?$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const root of TEST_ROOTS) walk(root);
  return found;
}

/**
 * Whether a test file reaches the product at all.
 *
 * Three ways count, because all three are used in this repo and only one of
 * them is a plain `import … from`:
 *
 *   - a relative import with bindings
 *   - a bare side-effect import, `import '../components/show-and-tell.js'`,
 *     which is how the UI's custom elements are registered before a test
 *     drives them. It has no `from` clause, so a `from`-shaped pattern walks
 *     straight past it — this guard called that file inert on its first run,
 *     and it is a real test.
 *   - reading or running a real artifact. `install-ps1-gateway.test.ts` runs
 *     the CLI through `execFile` and imports nothing but `vitest`;
 *     `cli-flags.test.ts` reads `index.ts` off disk.
 *
 * Miss any one of them and the guard fails a legitimate test file, which is
 * the more expensive direction to be wrong in.
 */
function reachesProduct(source: string): boolean {
  const boundImport = /^\s*import\s[\s\S]*?from\s+['"][^'"]*\.[./][^'"]*['"]/m.test(source);
  const sideEffectImport = /^\s*import\s+['"][^'"]*\.[./][^'"]*['"]/m.test(source);
  const dynamicAccess = /await\s+import\(|\brequire\(|\bexecFile|\bexecSync|\bspawn|\breadFile|\bcreateRequire|\bfetch\(/.test(source);
  return boundImport || sideEffectImport || dynamicAccess;
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

describe('no test file may be added that cannot fail', () => {
  const files = testFiles();

  it('scans a realistic number of test files, in both packages', () => {
    // Anti-vacuity: a broken walker would make every assertion below pass by
    // having nothing to look at — which is the exact failure being guarded.
    expect(files.length).toBeGreaterThan(200);

    // Per root, not on the merged total. A combined count stays healthy when
    // one root stops being scanned, because the other keeps it up — the trap
    // this repo has now hit four times.
    for (const root of TEST_ROOTS) {
      const inRoot = files.filter((f) => f.startsWith(root + path.sep));
      expect(inRoot.length, `no test files found under ${relative(root)}`).toBeGreaterThan(0);
    }
    expect(TEST_ROOTS.length, 'both the CLI and UI packages should be scanned').toBe(2);
  });

  it('recognises all three ways a test reaches the product', () => {
    // Detector control. If `reachesProduct` returned false for everything, the
    // inert set would swallow the whole suite; if it returned true for
    // everything, the guard would never fire again.
    expect(reachesProduct("import { thing } from '../../agents/BasicAgent.js';")).toBe(true);
    expect(reachesProduct("const out = await execFile(cli, ['--help']);")).toBe(true);
    expect(reachesProduct("const src = await fs.readFile(entry, 'utf-8');")).toBe(true);

    // The case that fooled the first version of this guard: a bare side-effect
    // import registering a custom element. It has no `from` clause.
    expect(reachesProduct("import '../components/show-and-tell.js';")).toBe(true);

    expect(reachesProduct("import { describe, it, expect } from 'vitest';")).toBe(false);
    expect(reachesProduct("import 'vitest';")).toBe(false);
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
