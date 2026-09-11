import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createPackage, uncache } from '@electron/asar';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY, protocolAuthorityDetails,
} from '../../dist/rapp/authority.js';
import {
  TYPESCRIPT_ROOT, desktopIdentity, dmgName, runCommand,
} from '../scripts/release-contract.mjs';
import afterPack, {
  BUILD_RECORD, PACKAGED_AUTHORITY, canonicalAuthority, generateReleaseArtifacts,
  parseManifestArgs, verifyAuthorityEmission, verifyBuildRecord, writeBuildRecord,
} from '../scripts/release-artifacts.mjs';
import { appFixture, releaseFixture } from './release-test-support.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));

async function packagedFixture(t) {
  const fixture = releaseFixture(t);
  const packageRoot = path.join(fixture.root, 'asar source');
  const authorityFile = path.join(packageRoot, PACKAGED_AUTHORITY);
  const runtimePackage = path.join(packageRoot, 'runtime/node_modules/openrappter/package.json');
  const resources = path.join(fixture.source, 'Contents', 'Resources');
  const archive = path.join(resources, 'app.asar');
  fs.mkdirSync(path.dirname(authorityFile), { recursive: true });
  fs.copyFileSync(path.join(TYPESCRIPT_ROOT, 'dist/rapp/authority.js'), authorityFile);
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: desktopIdentity().packageName, version: desktopIdentity().version,
  }));
  fs.writeFileSync(runtimePackage, JSON.stringify({
    name: 'openrappter', version: desktopIdentity().version,
  }));
  async function repack() {
    uncache(archive);
    await createPackage(packageRoot, archive);
  }
  await repack();
  const record = await writeBuildRecord(resources, { run: fixture.run });
  return {
    ...fixture, resources, record, authorityFile, runtimePackage, repack,
    generate: (options = {}) => generateReleaseArtifacts(fixture.dmg, {
      run: fixture.run, mount: fixture.mount, ...options,
    }),
  };
}

test('build provenance is derived from the selected canonical authority, never a release-script pin', async (t) => {
  const fixture = await packagedFixture(t);
  const canonical = await canonicalAuthority();
  assert.deepEqual(canonical.authority, { ...protocolAuthorityDetails(ACCEPTED_RAPP_PROTOCOL_AUTHORITY) });
  assert.equal(canonical.provenance.moduleSha256, hash(fs.readFileSync(fixture.authorityFile)));
  assert.equal(canonical.provenance.sourceSha256, hash(fs.readFileSync(
    path.join(TYPESCRIPT_ROOT, 'src/rapp/authority.ts'),
  )));
  assert.equal(canonical.provenance.packagedModule, PACKAGED_AUTHORITY);
  assert.deepEqual(fixture.record.rapp1, canonical);
  assert.deepEqual(await verifyBuildRecord(fixture.resources), fixture.record);
  const source = fs.readFileSync(new URL('../scripts/release-artifacts.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /rev-\d+|[0-9a-f]{40,64}/);
});

test('stale canonical JavaScript is rejected even when the packaged runtime matches it', () => {
  const source = fs.readFileSync(path.join(TYPESCRIPT_ROOT, 'src/rapp/authority.ts'));
  const compiled = fs.readFileSync(path.join(TYPESCRIPT_ROOT, 'dist/rapp/authority.js'));
  assert.doesNotThrow(() => verifyAuthorityEmission(source, compiled));
  assert.throws(() => verifyAuthorityEmission(
    Buffer.concat([source, Buffer.from('\nexport const releaseDrift = true;\n')]),
    compiled,
  ), /stale relative to its source/);
});

test('the actual electron-builder hook records the build commit before signing', async (t) => {
  const fixture = await packagedFixture(t);
  await afterPack({ electronPlatformName: 'darwin', appOutDir: fixture.volume });
  const record = await verifyBuildRecord(fixture.resources);
  assert.equal(record.gitCommit, runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: path.dirname(TYPESCRIPT_ROOT),
  }).trim());
  assert.equal(typeof record.gitDirty, 'boolean');
});

test('manifest and SHA-256 sidecar are deterministic and verified against the mounted app', async (t) => {
  const fixture = await packagedFixture(t);
  const first = await fixture.generate({ architecture: 'arm64', requireClean: true });
  const originalBytes = fs.readFileSync(first.manifestPath, 'utf8');
  const second = await fixture.generate({ architecture: 'arm64', requireClean: true });
  const checksum = hash(fs.readFileSync(fixture.dmg));
  assert.equal(fs.readFileSync(second.manifestPath, 'utf8'), originalBytes);
  assert.equal(fs.readFileSync(first.checksumPath, 'utf8'), `${checksum}  ${path.basename(fixture.dmg)}\n`);
  assert.deepEqual(first.manifest, {
    ...fixture.record,
    schema: 'rapp-work-release/1',
    architecture: 'arm64',
    dmg: { filename: path.basename(fixture.dmg), sha256: checksum, size: fs.statSync(fixture.dmg).size },
  });
  assert.ok(fixture.calls.some(({ args }) => args[0] === 'attach'));
  assert.ok(fixture.calls.some(({ args }) => args[0] === 'detach'));
});

test('every RAPP/1 authority claim is checked, including revision, checkpoint, and hashes', async (t) => {
  const fixture = await packagedFixture(t);
  for (const field of Object.keys(fixture.record.rapp1.authority)) {
    const record = plain(fixture.record);
    record.rapp1.authority[field] = 'unverified';
    fs.writeFileSync(path.join(fixture.resources, BUILD_RECORD), JSON.stringify(record));
    await assert.rejects(fixture.generate(), /unverified identity or RAPP\/1 authority/);
  }
  const record = plain(fixture.record);
  record.rapp1.provenance.moduleSha256 = '0'.repeat(64);
  fs.writeFileSync(path.join(fixture.resources, BUILD_RECORD), JSON.stringify(record));
  await assert.rejects(fixture.generate(), /unverified identity or RAPP\/1 authority/);
  assert.equal(fs.existsSync(`${fixture.dmg}.manifest.json`), false);
  assert.equal(fs.existsSync(`${fixture.dmg}.sha256`), false);
});

test('stale or modified bundled authority cannot acquire a build record or manifest', async (t) => {
  const fixture = await packagedFixture(t);
  fs.appendFileSync(fixture.authorityFile, '\n// stale runtime module\n');
  await fixture.repack();
  await assert.rejects(writeBuildRecord(fixture.resources, { run: fixture.run }), /differs from the canonical build/);
  await assert.rejects(fixture.generate(), /differs from the canonical build/);
  assert.equal(fs.existsSync(`${fixture.dmg}.manifest.json`), false);
});

test('missing build records and mismatched packaged runtime versions fail closed', async (t) => {
  const fixture = await packagedFixture(t);
  fs.rmSync(path.join(fixture.resources, BUILD_RECORD));
  await assert.rejects(fixture.generate(), /ENOENT/);
  fs.writeFileSync(fixture.runtimePackage, JSON.stringify({ name: 'openrappter', version: '0.0.0' }));
  await fixture.repack();
  await assert.rejects(writeBuildRecord(fixture.resources, { run: fixture.run }), /identity or version/);
  assert.equal(fs.existsSync(`${fixture.dmg}.manifest.json`), false);
});

test('malformed git identity fails closed', async (t) => {
  const fixture = await packagedFixture(t);
  const record = { ...fixture.record, gitCommit: [fixture.record.gitCommit] };
  fs.writeFileSync(path.join(fixture.resources, BUILD_RECORD), JSON.stringify(record));
  await assert.rejects(fixture.generate(), /unverified identity/);
});

test('symlink artifact outputs fail closed', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await packagedFixture(t);
  const unrelated = path.join(fixture.root, 'do-not-overwrite');
  fs.writeFileSync(unrelated, 'untouched');
  fs.symlinkSync(unrelated, `${fixture.dmg}.sha256`);
  await assert.rejects(fixture.generate(), /non-symlink file/);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'untouched');
});

test('dirty builds are explicit locally and rejected by the CI/release clean gate', async (t) => {
  const fixture = await packagedFixture(t);
  fixture.state.gitDirty = true;
  await writeBuildRecord(fixture.resources, { run: fixture.run });
  await assert.rejects(fixture.generate({ requireClean: true }), /require a clean build/);
  assert.equal(fs.existsSync(`${fixture.dmg}.manifest.json`), false);
  assert.equal((await fixture.generate()).manifest.gitDirty, true);
});

test('manifest architecture comes from the Mach-O executable, with exact filename and version checks', async (t) => {
  const fixture = await packagedFixture(t);
  await assert.rejects(fixture.generate({ architecture: 'x64' }), /architecture arm64 does not match x64/);
  appFixture(fixture.source, { version: '0.0.0' });
  await assert.rejects(fixture.generate(), /Unexpected app version/);
  appFixture(fixture.source, { architecture: 'universal' });
  await assert.rejects(fixture.generate(), /Expected DMG filename/);
  const universalDmg = path.join(fixture.root, dmgName('universal'));
  fs.renameSync(fixture.dmg, universalDmg);
  const result = await generateReleaseArtifacts(universalDmg, { run: fixture.run, mount: fixture.mount });
  assert.equal(result.manifest.architecture, 'universal');
});

test('a DMG changed during verification cannot receive a checksum or manifest', async (t) => {
  const fixture = await packagedFixture(t);
  fixture.state.afterDetach = () => fs.appendFileSync(fixture.dmg, 'changed');
  await assert.rejects(fixture.generate(), /DMG changed while/);
  assert.equal(fs.existsSync(`${fixture.dmg}.manifest.json`), false);
});

test('manifest argument parsing never chooses the first file in a release directory', () => {
  const options = parseManifestArgs(['--arch', 'arm64', '--require-clean']);
  assert.equal(path.basename(options.dmg), dmgName('arm64'));
  assert.equal(options.requireClean, true);
  assert.equal(parseManifestArgs(['--dmg', 'provided.dmg']).architecture, undefined);
  for (const args of [['--arch', 'invalid'], ['--dmg'], ['--arch', '--help'], ['--publish'], ['--require-clean', '--require-clean']]) {
    assert.throws(() => parseManifestArgs(args));
  }
});
