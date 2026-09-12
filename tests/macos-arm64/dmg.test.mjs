import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { packageMacRelease } from '../../packages/release/src/package-macos.mjs';
import { installDmg, verifyPackagedDmg } from '../../packages/release/src/installer.mjs';
import { put, releaseFixture } from '../../packages/release/test/helpers.mjs';

test('real unsigned development DMG mounts, verifies and installs only through explicit development mode', { timeout: 120_000 }, async t => {
  const fixture = await releaseFixture(t, { mode: 'development-unsigned' });
  await rm(path.join(fixture.appPath, 'Contents/Resources/rapp-work-build.json'));
  await put(fixture.appPath, 'Contents/Info.plist', '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.rapp.work</string><key>CFBundleExecutable</key><string>RAPP Work</string><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>');
  const outputDirectory = path.join(fixture.root, 'dist/real-dmg');
  const output = await packageMacRelease({ root: fixture.root, appPath: fixture.appPath, outputDirectory, version: '2.0.0', mode: 'development-unsigned' });
  const envelope = JSON.parse(await readFile(output.manifestPath, 'utf8'));
  const options = { root: fixture.root, dmgPath: output.dmgPath, envelope, mountDirectory: outputDirectory };
  await assert.rejects(verifyPackagedDmg(options), /Artifact mode differs/u);
  assert.equal((await verifyPackagedDmg({ ...options, mode: 'development-unsigned' })).status, 'verified');
  const applicationsDirectory = path.join(fixture.root, 'dist/Applications');
  await mkdir(applicationsDirectory, { mode: 0o700 });
  const installed = await installDmg({ ...options, applicationsDirectory, mode: 'development-unsigned' });
  assert.match(installed.destination, /RAPP Work Development\.app$/u);
  assert.equal(JSON.parse(await readFile(installed.journalPath, 'utf8')).state, 'committed');
});
