import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A documented environment variable has to be one something reads.
 *
 * The reference tables on the docs site listed five that nothing anywhere in
 * either runtime looked at: `OPENRAPPTER_CONFIG`, `OPENRAPPTER_LOG_LEVEL`,
 * `OPENRAPPTER_PROVIDER`, `GATEWAY_SECRET` and `OPENRAPPTER_NO_TELEMETRY`.
 *
 * Setting one produced no error and no effect, which is the same shape as the
 * config keys in #303 — except an environment variable has no schema to be
 * rejected by, so there was nothing that could have caught it.
 *
 * `OPENRAPPTER_NO_TELEMETRY` was the one worth fixing quickly. It was described
 * as disabling anonymous usage stats, which told a reader those stats existed.
 * They do not, in a product whose stated promise is that it is local-first, so
 * the documentation was both untrue and unflattering. If telemetry is ever
 * added, this test also means the opt-out cannot be documented before it works.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');

/**
 * Variables in the product's own namespace.
 *
 * Restricted to prefixes OpenRappter is responsible for, so a doc mentioning
 * `PATH` or a third-party variable is not held to this rule.
 */
const OWNED = /\b(OPENRAPPTER|GATEWAY|OPENAI|ANTHROPIC|GEMINI|OLLAMA|COPILOT|SLACK|DISCORD|TELEGRAM)_[A-Z0-9_]{2,}\b/g;

function documentedVars(): Map<string, string> {
  const found = new Map<string, string>();
  const docsDir = path.join(repoRoot, 'docs');
  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith('.html') || f.endsWith('.md'))
    .map((f) => path.join(docsDir, f));
  files.push(path.join(repoRoot, 'README.md'));

  for (const file of files.filter((f) => fs.existsSync(f))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // A passage that exists to say a variable is not real must not be read as
      // documenting it. Marked explicitly rather than guessed at from wording,
      // so removing the implementation and adding the marker stays a deliberate
      // act.
      if (line.includes('<!-- unimplemented -->')) return;
      // Only where the docs present it as a variable — a `<code>` span or a
      // shell `export`. Prose naming one in passing is not a promise.
      if (!/<code>|export |ENV|environment/i.test(line)) return;
      for (const match of line.matchAll(OWNED)) {
        const name = match[0];
        if (!found.has(name)) {
          found.set(name, `${path.relative(repoRoot, file)}:${i + 1}`);
        }
      }
    });
  }
  return found;
}

function sourceText(): string {
  const roots = [
    path.join(repoRoot, 'typescript', 'src'),
    path.join(repoRoot, 'typescript', 'desktop', 'src'),
    path.join(repoRoot, 'python', 'openrappter'),
    path.join(repoRoot, 'macos'),
  ].filter((p) => fs.existsSync(p));

  const chunks: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.build', '__pycache__', 'dist', '__tests__', 'tests'].includes(entry.name)) {
          continue;
        }
        walk(full);
        continue;
      }
      // Tests are excluded deliberately. A variable only a test mentions is not
      // one the product reads — and this file names the dead ones in its own
      // comment, which would otherwise make them look alive.
      if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      if (/^test_.*\.py$/.test(entry.name)) continue;
      if (!/\.(ts|tsx|js|mjs|py|swift)$/.test(entry.name)) continue;
      chunks.push(fs.readFileSync(full, 'utf8'));
    }
  };
  roots.forEach(walk);
  return chunks.join('\n');
}

describe('documented environment variables are variables something reads', () => {
  it('finds the documented variables', () => {
    // Guards the extractor: a pattern matching nothing would make the test
    // below pass over an empty set.
    const names = [...documentedVars().keys()];
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names).toContain('OPENRAPPTER_MODEL');
  });

  it('is read somewhere in the source', () => {
    const source = sourceText();
    const orphans: string[] = [];
    for (const [name, where] of documentedVars()) {
      if (!source.includes(name)) orphans.push(`  ${name}\n    documented at ${where}`);
    }
    expect(
      orphans,
      orphans.length
        ? 'These are documented as environment variables and nothing reads them.\n' +
          'Setting one produces no error and no effect.\n\n' +
          `${orphans.sort().join('\n\n')}\n`
        : '',
    ).toEqual([]);
  });
});
