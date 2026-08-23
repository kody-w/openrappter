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
