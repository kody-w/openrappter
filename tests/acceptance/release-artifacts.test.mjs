import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import test from 'node:test';
import { scanApplication } from '../../packages/release/src/legacy.mjs';
import { verifyProvenance, verifyRelease } from '../../packages/release/src/provenance.mjs';
import { releaseFixture } from '../../packages/release/test/helpers.mjs';

test('clean-artifact-allowlist', async t => {
  const fixture = await releaseFixture(t);
  const app = await scanApplication(fixture.appPath);
  assert.equal(app.digest, fixture.envelope.payload.app.digest);
  assert.deepEqual(app.asar.modules, fixture.envelope.payload.app.asar.modules);
  await verifyRelease({ ...fixture, ...fixture.trust });
});

test('altered-artifact-rejected', async t => {
  const fixture = await releaseFixture(t);
  await appendFile(fixture.dmgPath, 'altered');
  fixture.apple.calls.length = 0;
  await assert.rejects(verifyRelease({ ...fixture, ...fixture.trust }), /DMG checksum mismatch/u);
  assert.equal(fixture.apple.calls.length, 0);
});

test('unsigned-production-rejected', async t => {
  const fixture = await releaseFixture(t, { mode: 'development-unsigned' });
  assert.throws(() => verifyProvenance(fixture.envelope), /Artifact mode differs/u);
  const production = await releaseFixture(t);
  production.envelope.signature = null;
  assert.throws(() => verifyProvenance(production.envelope, production.trust), /Provenance signature/u);
});
