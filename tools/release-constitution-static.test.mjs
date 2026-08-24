import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { auditWorkflows } from './release-constitution-static.mjs';

const root = path.resolve('.release-constitution-test');
test('detects a new direct npm publish bypass', () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'bad.yml'), `jobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n`);
  const result = auditWorkflows(root);
  assert.match(result.violations.join('\n'), /bypasses release-constitution/);
  fs.rmSync(root, { recursive: true, force: true });
});
test('constitution-named workflows receive no filename exemption', () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'release-constitution-evil.yml'), `jobs:\n  escape:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@v4\n`);
  const result = auditWorkflows(root);
  assert.match(result.violations.join('\n'), /release-constitution-evil.*bypasses/);
  fs.rmSync(root, { recursive: true, force: true });
});
test('stable receiver proposes a checked PR and never writes protected main', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/apply-promotion.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /gh pr merge.*--auto --merge/);
  assert.doesNotMatch(workflow, /contents\/\.ring\/manifest\.json.*--method PUT/);
  assert.doesNotMatch(workflow, /push origin (?:HEAD:)?main/);
});
test('release publication materializes candidate bytes and never rebuilds them', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf('  build-artifacts:');
  const end = workflow.indexOf('  cycle-11-quality:');
  const block = workflow.slice(start, end);
  assert.match(block, /candidate\.tar\.gz/);
  assert.doesNotMatch(block, /npm run build|python -m build|pack-locked/);
});
test('release tag is created only after stable constitution and is idempotent', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/create-release-tag.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /create:[\s\S]*needs: release-constitution/);
  assert.match(workflow, /exact release tag already exists/);
  assert.match(workflow, /test "\$\(git rev-list -n 1 "\$RELEASE_TAG"\)" = "\$RELEASE_COMMIT"/);
  assert.match(workflow, /m\["source"\]\["tag"\] is None/);
  assert.ok(workflow.indexOf('Release Constitution') < workflow.indexOf('git push origin'));
});
