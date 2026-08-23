import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildProvenance, verifyProvenance } from './candidate-bundle.mjs';

const root = path.resolve('.candidate-bundle-test');
function fixture() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const name of ['openrappter-2.0.0.tgz', 'openrappter-2.0.0-py3-none-any.whl', 'openrappter-2.0.0.tar.gz', 'install.sh', 'install.ps1']) {
    fs.writeFileSync(path.join(root, name), name);
  }
  return buildProvenance(root, 'a'.repeat(40), '2.0.0', 'v2.0.0', 'release', 1234567890);
}
test('candidate provenance is deterministic and complete', () => {
  const first = fixture();
  const second = buildProvenance(root, 'a'.repeat(40), '2.0.0', 'v2.0.0', 'release', 1234567890);
  assert.deepEqual(first, second);
  verifyProvenance(root, first);
  fs.rmSync(root, { recursive: true, force: true });
});
test('tamper or rebuild under the same identity is rejected', () => {
  const provenance = fixture();
  fs.appendFileSync(path.join(root, 'openrappter-2.0.0.tgz'), 'tamper');
  assert.throws(() => verifyProvenance(root, provenance), /changed/);
  fs.rmSync(root, { recursive: true, force: true });
});
