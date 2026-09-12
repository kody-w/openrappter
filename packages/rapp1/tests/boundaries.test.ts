import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const names = ['rapp1', 'workspace-store', 'domain', 'security'] as const;
function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]);
}

describe('greenfield dependency and wire boundaries', () => {
  it.each(names)('%s imports only its own implementation, clean foundational packages or Node', (name) => {
    const folder = resolve(packages, name);
    const manifest = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
    expect(manifest.name).toBe(`@rapp-work/${name}`);
    const dependencies = Object.keys(manifest.dependencies ?? {});
    for (const dep of dependencies) expect(names.map((entry) => `@rapp-work/${entry}`)).toContain(dep);
    if (name === 'rapp1') expect(dependencies).toEqual([]);
    for (const file of files(resolve(folder, 'src')).filter((path) => extname(path) === '.ts')) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      function visit(node: ts.Node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          expect(node.arguments).toHaveLength(1);
          expect(ts.isStringLiteral(node.arguments[0]!)).toBe(true);
          if (ts.isStringLiteral(node.arguments[0]!)) imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/rappids|brainstem|participant|openrappter|typescript\/|legacy|apps\//i);
        if (specifier.startsWith('.')) {
          expect(resolve(dirname(file), specifier).startsWith(resolve(folder, 'src') + '/')).toBe(true);
        } else if (!specifier.startsWith('node:')) expect(dependencies).toContain(specifier);
      }
    }
  });
  it('has no compatibility exports, old envelope tokens or authority-selection loopholes', () => {
    for (const key of Object.keys(protocol)) expect(key).not.toMatch(/legacy|quantum|openrappter|rappids|compat/i);
    expect(protocol.FRAME_SPEC).toBe('rapp/1');
    expect(protocol.EVIDENCE_SCHEMA).toBe('openrappter-evidence/1');
    expect(protocol.RAPP1_AUTHORITY.identity.revision).toBe('rev-14');
    expect(protocol.isSelectedAuthority({ ...protocol.RAPP1_AUTHORITY })).toBe(false);
  });
  it('keeps the declared dependency graph acyclic', () => {
    const graph = new Map(names.map((name) => {
      const manifest = JSON.parse(readFileSync(resolve(packages, name, 'package.json'), 'utf8'));
      return [`@rapp-work/${name}`, Object.keys(manifest.dependencies ?? {})];
    }));
    const active = new Set<string>(), visited = new Set<string>();
    function walk(name: string) {
      expect(active.has(name), `cycle at ${name}`).toBe(false);
      if (visited.has(name)) return;
      active.add(name);
      for (const dependency of graph.get(name) ?? []) walk(dependency);
      active.delete(name); visited.add(name);
    }
    for (const name of graph.keys()) walk(name);
  });
});
