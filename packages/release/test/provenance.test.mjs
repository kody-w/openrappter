import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sourceSnapshot, verifySource } from '../src/inventory.mjs';
import { createProvenance, verifyApplication, verifyDmgBytes, verifyProvenance, verifyRelease } from '../src/provenance.mjs';
import { commitFixture, put, releaseFixture, sourceFixture, TEAM } from './helpers.mjs';

test('source provenance covers every tracked file and every lock, not selected build folders', async t => {
  const root = await sourceFixture(t);
  const snapshot = await sourceSnapshot(root);
  assert.equal(snapshot.dirty, false);
  assert.deepEqual(snapshot.locks.entries.map(entry => entry.path), ['package-lock.json', 'packages/release/package-lock.json']);
  for (const relative of ['LICENSE', 'README.md', '.github/workflows/ci.yml', 'scripts/build.mjs', 'tests/acceptance/smoke.test.mjs', 'packages/rapp1/fixtures/authority.json']) {
    assert(snapshot.entries.some(entry => entry.path === relative));
  }
  await verifySource(root, snapshot);
  await appendFile(path.join(root, 'README.md'), 'changed\n');
  await assert.rejects(verifySource(root, snapshot), /clean committed source tree/u);
});

test('untracked source and a missing root lock cannot produce production provenance', async t => {
  const root = await sourceFixture(t);
  await put(root, 'apps/desktop/src/untracked.mjs', 'export const changed = true;\n');
  await assert.rejects(sourceSnapshot(root), /clean committed source tree/u);
  await rm(path.join(root, 'apps/desktop/src/untracked.mjs'));
  await rm(path.join(root, 'package-lock.json'));
  commitFixture(root);
  await assert.rejects(sourceSnapshot(root), /package-lock.json/u);
});

test('development still inventories untracked source and actual executable mode changes', async t => {
  const root = await sourceFixture(t);
  const before = await sourceSnapshot(root, { requireClean: false });
  await put(root, 'apps/desktop/src/new.mjs', 'export const newlyAuthored = true;\n', 0o755);
  const after = await sourceSnapshot(root, { requireClean: false });
  assert.equal(after.dirty, true);
  assert.notEqual(before.digest, after.digest);
  assert.equal(after.entries.find(entry => entry.path === 'apps/desktop/src/new.mjs').mode, 0o755);
});

test('Git assume-unchanged flags cannot bless altered production source', async t => {
  const root = await sourceFixture(t);
  execFileSync('git', ['-C', root, 'update-index', '--assume-unchanged', 'README.md']);
  await appendFile(path.join(root, 'README.md'), 'hidden alteration\n');
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  await assert.rejects(sourceSnapshot(root), /differs from its committed blob/u);
  assert.equal((await sourceSnapshot(root, { requireClean: false })).dirty, true);
});

test('a subtree or escaping source symlink is not a complete source release', async t => {
  const root = await sourceFixture(t);
  await assert.rejects(sourceSnapshot(path.join(root, 'apps/desktop')), /complete repository root/u);
  await symlink(path.dirname(root), path.join(root, 'outside'));
  commitFixture(root);
  await assert.rejects(sourceSnapshot(root), /Escaping source symlink/u);
});

test('production verifies independent provenance trust, source, sealed receipt and Apple requirements', async t => {
  const fixture = await releaseFixture(t);
  const result = await verifyRelease({ ...fixture, ...fixture.trust });
  assert.equal(result.status, 'verified');
  assert.equal(result.mode, 'production');
  assert.equal(result.commit, fixture.inputs.source.commit);
  assert(fixture.apple.calls.some(([kind]) => kind === 'application'));
  assert(fixture.apple.calls.some(([kind]) => kind === 'dmg'));
});

test('a self-signed or untrusted manifest, authority substitution, and changed commit fail closed', async t => {
  const fixture = await releaseFixture(t);
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => verifyProvenance(fixture.envelope, { ...fixture.trust, trustedPublicKey: other.publicKey }), /not trusted/u);
  assert.throws(() => verifyProvenance(fixture.envelope, { mode: 'production', teamIdentifier: TEAM }), /independently trusted/u);
  assert.throws(() => verifyProvenance(fixture.envelope, { ...fixture.trust, expectedCommit: '0'.repeat(40) }), /trusted release commit/u);
  const changed = structuredClone(fixture.envelope);
  changed.payload.authority.revision = 'not-selected';
  assert.throws(() => verifyProvenance(changed, fixture.trust), /Noncanonical RAPP\/1 authority/u);
  const altered = structuredClone(fixture.envelope);
  altered.payload.source.commit = '0'.repeat(40);
  assert.throws(() => verifyProvenance(altered, fixture.trust), /signature verification failed/u);
});

test('altered DMG is rejected before any installer or Apple process executes', async t => {
  const fixture = await releaseFixture(t);
  fixture.apple.calls.length = 0;
  await appendFile(fixture.dmgPath, 'altered');
  await assert.rejects(verifyRelease({ ...fixture, ...fixture.trust }), /DMG checksum mismatch/u);
  assert.equal(fixture.apple.calls.length, 0);
});

test('changed bundled code and even an extra clean-named resource invalidate the entire app', async t => {
  const fixture = await releaseFixture(t);
  await appendFile(path.join(fixture.appPath, 'Contents/MacOS/RAPP Work'), 'altered');
  await assert.rejects(verifyApplication(fixture.appPath, fixture.envelope, { ...fixture.trust, apple: fixture.apple }), /Complete application tree mismatch/u);
  await put(fixture.appPath, 'Contents/Resources/unexpected.json', '{}');
  await assert.rejects(verifyApplication(fixture.appPath, fixture.envelope, { ...fixture.trust, apple: fixture.apple }), /Unallowlisted application entry/u);
});

test('unsigned development is explicit, unmistakable and impossible to verify as production', async t => {
  const fixture = await releaseFixture(t, { mode: 'development-unsigned' });
  assert.match(fixture.dmgPath, /UNSIGNED-DEVELOPMENT\.dmg$/u);
  assert.equal(fixture.envelope.signature, null);
  assert.equal(fixture.envelope.payload.signing, null);
  assert.throws(() => verifyProvenance(fixture.envelope), /Artifact mode differs/u);
  assert.equal(verifyProvenance(fixture.envelope, fixture.trust).mode, 'development-unsigned');
  await verifyDmgBytes(fixture.dmgPath, fixture.envelope, fixture.trust);
});

test('unsigned, non-hardened, unstapled, unnotarized, and wrong-team production evidence are rejected', async t => {
  const fixture = await releaseFixture(t);
  const unsigned = structuredClone(fixture.envelope);
  unsigned.signature = null;
  assert.throws(() => verifyProvenance(unsigned, fixture.trust), /signature must be a plain object/u);
  for (const requirement of ['hardenedRuntime', 'notarized', 'stapled']) {
    const invalid = structuredClone(fixture.envelope);
    invalid.payload.signing[requirement] = false;
    assert.throws(() => verifyProvenance(invalid, fixture.trust), /Production requires/u);
  }
  assert.throws(() => verifyProvenance(fixture.envelope, { ...fixture.trust, teamIdentifier: 'WRONGTEAM1' }), /trusted team/u);
});

test('changing a nonsampled source or canonical fixture after the build receipt blocks packaging', async t => {
  const fixture = await releaseFixture(t);
  await appendFile(path.join(fixture.root, 'scripts/build.mjs'), '// changed\n');
  commitFixture(fixture.root);
  await assert.rejects(createProvenance({
    ...fixture, ...fixture.inputs, version: '2.0.0', mode: 'production',
    teamIdentifier: TEAM, privateKey: fixture.keys.privateKey,
  }), /Source changed during packaging/u);
});
