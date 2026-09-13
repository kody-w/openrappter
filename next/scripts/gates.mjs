import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { CanonicalRepository } from '../dist/repository.js';
import { Bots } from '../dist/bots.js';
import { SharedBrainstem, targetCapability, UnavailableBrainstem } from '../dist/spine.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const primitiveRoot = path.resolve(root, '../packages/rapp1/src');
const adopted = JSON.parse(await readFile(path.join(root, 'adopted-primitives.json'), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, sha256] of Object.entries(adopted.files)) {
  assert.equal(digest(await readFile(path.join(primitiveRoot, name))), sha256, `Adopted primitive drift: ${name}`);
}
const sources = [];
async function walk(directory) {
  for (const e of await readdir(directory, { withFileTypes: true })) {
    assert(!e.isSymbolicLink(), 'No source symlink authority');
    if (e.isDirectory()) await walk(path.join(directory, e.name));
    else if (e.name.endsWith('.ts')) sources.push(path.join(directory, e.name));
  }
}
await walk(path.join(root, 'src'));
const imports = [];
for (const source of sources) {
  const text = await readFile(source, 'utf8');
  const parsed = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0);
  function inspect(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        assert(ts.isStringLiteral(node.moduleSpecifier), 'Computed module loading is forbidden');
        const name = node.moduleSpecifier.text;
        imports.push({ source: path.relative(root, source), name });
        if (name.startsWith('.')) {
          const target = path.resolve(path.dirname(source), name);
          assert(target.startsWith(path.join(root, 'src') + path.sep)
            || (path.basename(source) === 'canonical.ts' && name === '../../packages/rapp1/dist/index.js'),
          `Old application import: ${name}`);
        } else {
          assert(name.startsWith('node:') || name === '@github/copilot-sdk', `Unadopted dependency: ${name}`);
          assert(!['node:child_process', 'node:sqlite', 'node:vm', 'node:worker_threads'].includes(name), `Host execution/storage escape: ${name}`);
        }
      }
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text)))) {
      assert.fail('Dynamic module or code loading is not part of the trusted core');
    }
    ts.forEachChild(node, inspect);
  }
  inspect(parsed);
  assert(!/\b(?:deleteBot|deleteWorld|deleteWorkspace)\b/u.test(text));
}
assert.equal(imports.filter(i => i.name.includes('/packages/')).length, 1);

const scratch = path.join(root, '.test-scratch', `foundation-proof-${process.pid}-${Date.now()}`);
await mkdir(scratch, { recursive: true, mode: 0o700 });
const repository = await CanonicalRepository.open({ directory: path.join(scratch, 'canonical') });
const capability = await targetCapability();
const spine = new SharedBrainstem(new UnavailableBrainstem(), [capability]);
const bots = new Bots({ repository, capability: capability.reference, spine });
const bot = await bots.create({ name: 'Foundation proof', operationId: 'foundation-proof' });
await bots.visibility(bot.root, true, 'foundation-hide');
await bots.visibility(bot.root, false, 'foundation-restore');
const before = await repository.snapshot();
assert.equal(before.frameCount, 3);
const restarted = await CanonicalRepository.open({ directory: repository.directory });
assert.deepEqual(await restarted.snapshot(), before);
const check = spawnSync('python3', [path.join(root, 'scripts/reference-check.py'), repository.directory],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
if (check.status !== 0) throw new Error(check.stderr + check.stdout);
const result = { schema: 'rapp-work.next/foundation-gates/1', importsChecked: imports.length,
  adoptedPrimitives: Object.keys(adopted.files).length, noOldAppImports: true, uiModules: 0,
  deterministicRestart: true, exactRoot: bot.root, canonical: JSON.parse(check.stdout) };
await writeFile(path.join(scratch, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
