import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
  return buildProvenance(root, 'a'.repeat(40), null, { npm: '1.13.0', pypi: '1.13.0', runtime: '1.13.0', channel: '0.1.0-beta.11' }, 'v1.13.0', 'release', 'tag-djEuMTMuMA', 1234567890);
}
test('candidate provenance is deterministic and complete', () => {
  const first = fixture();
  const second = buildProvenance(root, 'a'.repeat(40), null, { npm: '1.13.0', pypi: '1.13.0', runtime: '1.13.0', channel: '0.1.0-beta.11' }, 'v1.13.0', 'release', 'tag-djEuMTMuMA', 1234567890);
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
  const release = { kind: 'release', id: 'tag-djEuMTMuMA', bundle_sha256: 'c'.repeat(64), path: candidateStoragePath(commit, 'release', 'tag-djEuMTMuMA'), source_date_epoch: 1 };
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
  assert.equal(provenance.source_tag, null);
  assert.equal(provenance.intended_release_tag, 'v1.13.0');
  assert.equal(provenance.candidate_id, 'tag-djEuMTMuMA');
  verifyProvenance(root, provenance);
  fs.rmSync(root, { recursive: true, force: true });
});

test('first candidate branch creation tolerates an already-empty orphan index', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/build-candidate.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /git switch --orphan candidates; git rm -rf \. --ignore-unmatch/,
  );

  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-orphan-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
      cwd: repository,
    });
    fs.writeFileSync(path.join(repository, 'tracked.txt'), 'baseline\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repository });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], {
      cwd: repository,
    });
    execFileSync('git', ['switch', '--orphan', 'candidates'], {
      cwd: repository,
    });
    execFileSync('git', ['rm', '-rf', '.', '--ignore-unmatch'], {
      cwd: repository,
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
