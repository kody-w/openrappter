import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every environment variable the documentation promises must be read somewhere.
 *
 * Documentation that names a setting nothing reads is the same defect as a
 * config section nothing enforces (#219) or an RPC method nothing registers
 * (#206): the reader has every reason to believe it works, and no way to find
 * out that it does not.
 *
 * The scan deliberately covers shell scripts and workflows as well as source.
 * Writing this guard, my first pass looked only at TypeScript, Python and Swift
 * and reported `OPENRAPPTER_COMMIT` and `OPENRAPPTER_INSTALL_ROOT` as
 * undocumented fiction. Both are real — they are read by `install-pinned.sh`
 * and `pinned-install.yml`. A guard narrower than the product it checks
 * produces confident false findings, which is worse than no guard.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

const DOC_SOURCES = ['README.md', 'docs'];
const CODE_ROOTS = [
  'typescript/src',
  'typescript/ui/src',
  'typescript/desktop/src',
  'typescript/desktop/test',
  'python/openrappter',
  'macos/Sources',
  'scripts',
  '.github/workflows',
  'install-pinned.sh',
  'install.sh',
  'conformance.py',
];

const ENV_PATTERN = /OPENRAPPTER_[A-Z0-9_]+/g;

function walk(target: string, accept: (file: string) => boolean): string[] {
  const full = path.join(repoRoot, target);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return accept(full) ? [full] : [];

  const out: string[] = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const child = path.join(target, entry.name);
    out.push(...walk(child, accept));
  }
  return out;
}

/** Every OPENRAPPTER_* name mentioned across a set of roots. */
function namesIn(roots: string[], accept: (file: string) => boolean): Set<string> {
  const found = new Set<string>();
  for (const root of roots) {
    for (const file of walk(root, accept)) {
      const body = fs.readFileSync(file, 'utf8');
      for (const match of body.match(ENV_PATTERN) ?? []) found.add(match);
    }
  }
  return found;
}

const isMarkdown = (f: string) => f.endsWith('.md');
/**
 * Production and tooling code, never tests.
 *
 * The exclusion is load-bearing, and the control test below is what found that
 * out: this file lives under `typescript/src`, so without it the scan read its
 * own source and reported the deliberately-fake name as used. A variable
 * mentioned only in a test is not a variable the product reads.
 */
const isCode = (f: string) =>
  /\.(ts|tsx|js|mjs|py|swift|sh|yml|yaml)$/.test(f)
  && !f.endsWith('.d.ts')
  && !/(^|[\\/])(__tests__|tests|test)[\\/]/.test(f)
  && !/\.test\.[a-z]+$/.test(f)
  && !/(^|[\\/])test_[^\\/]+\.py$/.test(f);

describe('documented environment variables are real', () => {
  it('finds documentation and code to compare', () => {
    // Without this the comparison passes by reading nothing.
    expect(namesIn(DOC_SOURCES, isMarkdown).size).toBeGreaterThan(5);
    expect(namesIn(CODE_ROOTS, isCode).size).toBeGreaterThan(30);
  });

  it('every variable the docs name is read somewhere', () => {
    const documented = namesIn(DOC_SOURCES, isMarkdown);
    const used = namesIn(CODE_ROOTS, isCode);
    const fiction = [...documented].filter((name) => !used.has(name)).sort();
    expect(fiction).toEqual([]);
  });

  it('the switch that turns gateway authentication on is documented', () => {
    // OPENRAPPTER_TOKEN is read in ten places and was documented in none.
    // It is the only thing that moves the gateway off `auth: { mode: 'none' }`,
    // so a reader who cannot find it cannot secure the gateway at all.
    const documented = namesIn(DOC_SOURCES, isMarkdown);
    expect(documented.has('OPENRAPPTER_TOKEN')).toBe(true);
  });

  it('would notice a documented variable that nothing reads (control)', () => {
    // Proves the comparison discriminates rather than accepting any input.
    const used = namesIn(CODE_ROOTS, isCode);
    expect(used.has('OPENRAPPTER_TOKEN')).toBe(true);
    expect(used.has('OPENRAPPTER_NOT_A_REAL_SETTING')).toBe(false);
  });
});
