import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { builtinModules } from 'module';

/**
 * `gateway/server.ts` must stay importable by the UI package.
 *
 * `typescript/ui/src/__tests__/gateway.integration.test.ts` imports
 * `GatewayServer` directly and runs a real gateway to test the UI's client
 * against it. That is a genuine contract test and worth keeping — but the UI
 * package installs only its own dependencies in CI, and declares `ws` as a
 * devDependency purely so that import resolves.
 *
 * So there is an invariant nothing stated: every package reachable from
 * `server.ts` through *static* imports must be a Node builtin or declared by
 * the UI package. Add one static import that transitively reaches something
 * else and the Dashboard UI job fails, far from the change that caused it.
 *
 * That happened twice in a single day, to two different people:
 *
 *   #185  server.ts -> skills/bundled.ts -> clawhub.ts -> agents/index.js
 *                   -> AgentRegistry.ts -> logging/logger.ts -> chalk
 *   #188  server.ts -> agents/agent-files.ts -> AgentRegistry.ts
 *                   -> logging/logger.ts -> chalk
 *
 * Both were fixed the right way — a lazy import inside the handler, and
 * extracting the shared piece into a dependency-free module — but only after a
 * remote CI round-trip and an error message (`Cannot find package 'chalk'`)
 * that says nothing about the import that caused it.
 *
 * This fails locally instead, and prints the chain.
 */

const TS_ROOT = resolve(__dirname, '../..');
const UI_PACKAGE = resolve(TS_ROOT, '../ui/package.json');
const UI_SRC = resolve(TS_ROOT, '../ui/src');

function uiProvidedPackages(): Set<string> {
  const pkg = JSON.parse(readFileSync(UI_PACKAGE, 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

/** Static `import`/`export … from` specifiers, ignoring `await import(...)`. */
function staticSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  // `export { X } from './y.js'` and `export * from './y.js'` are part of the
  // static graph too. Missing them made an earlier version of this walker stop
  // at agents/index.ts, which is nothing but re-exports — so it reported the
  // graph clean while chalk was two hops further on.
  for (const match of withoutComments.matchAll(
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
  )) {
    found.push(match[1]);
  }
  for (const match of withoutComments.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  return found;
}

function resolveLocal(fromFile: string, specifier: string): string | undefined {
  const base = join(dirname(fromFile), specifier.replace(/\.js$/, ''));
  // `.js` last: `voice/local-speech.js` is hand-written JavaScript with a
  // sibling .d.ts, so a .ts-only resolver walks straight past it.
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), `${base}.js`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Every module the UI package reaches into `typescript/src` for.
 *
 * Derived rather than hardcoded. This test used to name `gateway/server.ts`
 * alone, which was the module I happened to be debugging — but the UI also
 * imports `voice/local-speech.js`, and nothing would have noticed if that one
 * started pulling in a Node-only package. Deriving the list means a new
 * UI-to-src import is guarded the moment somebody writes it.
 */
function uiEntryPoints(): string[] {
  const entries = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      const source = readFileSync(full, 'utf-8');
      for (const match of source.matchAll(/from\s*'((?:\.\.\/)+src\/[^']+)'/g)) {
        const resolved = resolveLocal(full, match[1]);
        if (resolved) entries.add(resolved);
      }
    }
  };
  walk(UI_SRC);
  return [...entries].sort();
}

/** Bare package specifiers reachable from the entry, with the chain that reached each. */
function reachablePackages(): Map<string, string[]> {
  const packages = new Map<string, string[]>();
  const seen = new Set<string>();

  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, file.replace(`${TS_ROOT}/`, '')];

    for (const specifier of staticSpecifiers(readFileSync(file, 'utf-8'))) {
      if (specifier.startsWith('.')) {
        const next = resolveLocal(file, specifier);
        if (next) walk(next, here);
        continue;
      }
      if (specifier.startsWith('node:')) continue;
      const name = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (builtinModules.includes(name)) continue;
      if (!packages.has(name)) packages.set(name, here);
    }
  };

  for (const entry of uiEntryPoints()) walk(entry, []);
  return packages;
}

describe('the gateway stays importable by the UI package', () => {
  it('finds every module the UI reaches into src for', () => {
    // Derived, not hardcoded — and asserted so a broken scan cannot leave the
    // real check walking an empty list. There are two today: the gateway and
    // the speech seam.
    const entries = uiEntryPoints().map((e) => e.replace(`${TS_ROOT}/`, ''));
    expect(entries.length).toBeGreaterThan(1);
    expect(entries).toContain('gateway/server.ts');
  });

  it('finds a non-trivial import graph', () => {
    // Guards the walker. If resolution silently stops at the entry file, the
    // assertion below would pass over almost nothing.
    expect(reachablePackages().size).toBeGreaterThan(0);
    expect(Array.from(new Set(reachablePackages().values())).length).toBeGreaterThan(0);
  });

  it('reaches no package the UI does not install', () => {
    const provided = uiProvidedPackages();
    const offenders = [...reachablePackages().entries()]
      .filter(([name]) => !provided.has(name))
      .map(([name, chain]) => `${name}\n      via ${chain.join('\n        -> ')}`);

    expect(
      offenders,
      offenders.length
        ? `gateway/server.ts statically imports packages the UI package does not install.\n` +
            `The Dashboard UI CI job imports GatewayServer with only its own deps, so this breaks it.\n` +
            `Fix by importing lazily inside the handler, or by extracting the shared piece into a\n` +
            `dependency-free module — do not add the package to typescript/ui.\n\n` +
            offenders.join('\n\n')
        : undefined,
    ).toEqual([]);
  });
});
