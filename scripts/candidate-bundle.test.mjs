import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addCandidateIndexEntry, buildProvenance, candidateStoragePath, verifyProvenance } from './candidate-bundle.mjs';

const root = path.resolve('.candidate-bundle-test');
function fixture() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  for (const name of ['openrappter-1.13.0.tgz', 'openrappter-1.13.0-py3-none-any.whl', 'openrappter-1.13.0.tar.gz', 'install.sh', 'install.ps1']) {
    fs.writeFileSync(path.join(root, name), name);
  }
  return buildProvenance(root, 'a'.repeat(40), { npm: '1.13.0', pypi: '1.13.0', runtime: '1.13.0', channel: '0.1.0-beta.11' }, 'v0.1.0-beta.11', 'release', 'v0.1.0-beta.11', 1234567890);
}
test('candidate provenance is deterministic and complete', () => {
  const first = fixture();
  const second = buildProvenance(root, 'a'.repeat(40), { npm: '1.13.0', pypi: '1.13.0', runtime: '1.13.0', channel: '0.1.0-beta.11' }, 'v0.1.0-beta.11', 'release', 'v0.1.0-beta.11', 1234567890);
  assert.deepEqual(first, second);
  verifyProvenance(root, first);
  fs.rmSync(root, { recursive: true, force: true });
});
test('tamper or rebuild under the same identity is rejected', () => {
  const provenance = fixture();
  fs.appendFileSync(path.join(root, 'openrappter-1.13.0.tgz'), 'tamper');
  assert.throws(() => verifyProvenance(root, provenance), /changed/);
  fs.rmSync(root, { recursive: true, force: true });
});
test('same commit snapshot and release coexist while identical replay is idempotent', () => {
  const commit = 'a'.repeat(40);
  const base = { schema: 'openrappter-candidate-index/v1', source_commit: commit, snapshots: [], releases: [] };
  const snapshot = { kind: 'snapshot', id: 'snapshot-1', bundle_sha256: 'b'.repeat(64), path: candidateStoragePath(commit, 'snapshot', 'snapshot-1'), source_date_epoch: 1 };
  const release = { kind: 'release', id: 'v0.1.0-beta.11', bundle_sha256: 'c'.repeat(64), path: candidateStoragePath(commit, 'release', 'v0.1.0-beta.11'), source_date_epoch: 1 };
  const both = addCandidateIndexEntry(addCandidateIndexEntry(base, snapshot), release);
  assert.equal(both.snapshots.length, 1);
  assert.equal(both.releases.length, 1);
  assert.deepEqual(addCandidateIndexEntry(both, release), both);
  assert.throws(
    () => addCandidateIndexEntry(both, { ...release, bundle_sha256: 'd'.repeat(64) }),
    /conflicting rebuild/,
  );
});
test('beta.11 provenance preserves dual package and channel identities', () => {
  const provenance = fixture();
  assert.deepEqual(provenance.versions, {
    npm: '1.13.0',
    pypi: '1.13.0',
    runtime: '1.13.0',
    channel: '0.1.0-beta.11',
  });
  test('workflow stores candidates in kind and ID namespaces', () => {
    const workflow = fs.readFileSync(new URL('../.github/workflows/build-candidate.yml', import.meta.url), 'utf8');
    assert.match(workflow, /candidates\/\$SOURCE_COMMIT\/\$CANDIDATE_KIND\/\$CANDIDATE_ID/);
    assert.match(workflow, /candidates\/\$SOURCE_COMMIT\/index\.json/);
    assert.doesNotMatch(workflow, /path="candidates\/\$SOURCE_COMMIT"\s*$/m);
  });
  assert.equal(provenance.release_tag, 'v0.1.0-beta.11');
  assert.equal(provenance.candidate_id, 'v0.1.0-beta.11');
  verifyProvenance(root, provenance);
  fs.rmSync(root, { recursive: true, force: true });
});
