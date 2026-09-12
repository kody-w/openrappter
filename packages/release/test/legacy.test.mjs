import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inspectAsar, machOArchitectures } from '../src/asar.mjs';
import { scanApplication, scanAsar, scanResources, scanSource } from '../src/legacy.mjs';
import { appFiles, arm64MachO, makeAsar, negative, put, releaseFixture, scratch, sourceFixture } from './helpers.mjs';

test('a clean source workspace and complete packaged application pass their respective gates', async t => {
  const fixture = await releaseFixture(t);
  assert.equal((await scanSource(fixture.root)).workspaces.length, 14);
  const app = await scanApplication(fixture.appPath);
  assert.deepEqual(app.asar.modules, ['@rapp-work/desktop']);
  const resources = await scanResources(path.join(fixture.appPath, 'Contents/Resources'));
  assert.equal(resources.asar.digest, app.asar.digest);
});

test('physical legacy source directories fail even if no module imports them', async t => {
  const root = await sourceFixture(t);
  await mkdir(path.join(root, negative.legacyRoot));
  await assert.rejects(scanSource(root), /Removed source root still exists/u);
});

test('static, escaped, and computed module loading cannot evade the source import gate', async t => {
  const root = await sourceFixture(t);
  for (const code of [negative.legacyImport, negative.escapedLegacyImport, negative.computedImport, negative.normativeImport]) {
    await put(root, 'apps/desktop/src/import.mjs', code);
    await assert.rejects(scanSource(root), /Removed|Computed module/u);
  }
});

test('syntax-aware import scanning distinguishes comments and strings from executable imports', async t => {
  const root = await sourceFixture(t);
  await put(root, 'apps/desktop/src/documentation.mjs', '// Type emitters may write import() syntax.\nexport const documentation = "import(variable)";\n');
  await scanSource(root);
  await put(root, 'apps/desktop/src/documentation.mjs', 'import {');
  await assert.rejects(scanSource(root), /Unparseable source/u);
});

test('only the exact normative wire literal is exempt, never its prefix or an import', async t => {
  const root = await sourceFixture(t);
  await put(root, 'packages/release/src/wire.mjs', `export const schema = ${JSON.stringify(negative.normativeWire)};\n`);
  await scanSource(root);
  await put(root, 'packages/release/src/wire.mjs', `export const schema = ${JSON.stringify(`${negative.normativeWire}-runtime`)};\n`);
  await assert.rejects(scanSource(root), /Removed identifier/u);
});

test('an allowlisted inert migration fixture is source-only, not a packaging exemption', async t => {
  const root = await sourceFixture(t);
  await put(root, 'tests/fixtures/migration/legacy-home.json', { marker: negative.legacyIdentifier });
  await scanSource(root);
  const asar = await put(path.join(root, 'dist'), 'app.asar', makeAsar(appFiles('2.0.0', { 'dist/fixture.json': JSON.stringify({ marker: negative.legacyIdentifier }) })));
  await assert.rejects(scanAsar(asar), /Removed identifier/u);
});

test('undeclared workspaces, old dependencies, and source symlink escapes fail', async t => {
  const root = await sourceFixture(t);
  await put(root, 'packages/unexpected/package.json', { name: '@rapp-work/unexpected' });
  await assert.rejects(scanSource(root), /Unallowlisted workspace/u);
  await rm(path.join(root, 'packages/unexpected'), { recursive: true });
  await put(root, 'packages/release/package.json', { name: '@rapp-work/release', dependencies: { [negative.legacyPackage]: '1.0.0' } });
  await assert.rejects(scanSource(root), /Removed workspace dependency/u);
  await put(root, 'packages/release/package.json', { name: '@rapp-work/release' });
  await symlink(path.dirname(root), path.join(root, 'outside'));
  await assert.rejects(scanSource(root), /Source symlink/u);
});

test('ASAR rejects removed modules, unlisted dependencies, injected resources and nested dependency escapes', async t => {
  const root = await scratch(t);
  const variants = [
    { [negative.legacyResource]: '<html></html>' },
    { [negative.legacyNativeAsset]: 'inert fixture' },
    { 'node_modules/unapproved/package.json': '{"name":"unapproved"}' },
    { 'dist/node_modules/unapproved/package.json': '{"name":"unapproved"}' },
    { 'dist/removed.js': negative.legacyImport },
  ];
  for (const extras of variants) {
    const asar = await put(root, 'app.asar', makeAsar(appFiles('2.0.0', extras)));
    await assert.rejects(scanAsar(asar), /Removed|Unallowlisted/u);
  }
});

test('the entire Resources directory is inspected, not only app.asar', async t => {
  const fixture = await releaseFixture(t);
  await put(fixture.appPath, `Contents/Resources/${negative.legacyResource}`, '<html></html>');
  await assert.rejects(scanApplication(fixture.appPath), /Removed path|Unallowlisted/u);
});

test('approved package subpath metadata is inspected without inventing additional runtime modules', async t => {
  const root = await scratch(t);
  const asar = await put(root, 'app.asar', makeAsar(appFiles('2.0.0', {
    'node_modules/zod/package.json': '{"name":"zod","version":"4.0.0"}',
    'node_modules/zod/v4/package.json': '{"type":"module"}',
    'node_modules/zod/v4/index.js': 'export const schema = true;',
  })));
  assert.deepEqual((await scanAsar(asar)).modules, ['@rapp-work/desktop', 'zod']);
});

test('a source-looking script or omitted host output is not a complete desktop artifact', async t => {
  const fixture = await releaseFixture(t);
  const asar = await put(path.dirname(fixture.appPath), 'extra.asar', makeAsar(appFiles('2.0.0', { 'dist/start.sh': 'exit 0' })));
  await assert.rejects(scanAsar(asar), /Unallowlisted ASAR entry/u);
  await rm(path.join(fixture.appPath, 'Contents/Resources/host/host.cjs'));
  await assert.rejects(scanApplication(fixture.appPath), /Missing application resource/u);
});

test('malformed ASAR, trailing payload and wrong native architecture are rejected', async t => {
  const root = await scratch(t);
  const asar = await put(root, 'app.asar', makeAsar(appFiles()));
  await appendFile(asar, 'unaccounted bytes');
  await assert.rejects(inspectAsar(asar), /trailing unaccounted/u);
  await put(root, 'app.asar', Buffer.alloc(16));
  await assert.rejects(inspectAsar(asar), /Invalid ASAR/u);
  const wrong = arm64MachO();
  wrong.writeUInt32LE(0x01000007, 4);
  assert.deepEqual(machOArchitectures(wrong), ['x86_64']);
  const nativeAsar = await put(root, 'app.asar', makeAsar(appFiles('2.0.0', { 'dist/helper': wrong })));
  await assert.rejects(scanAsar(nativeAsar), /Non-arm64/u);
});

test('standalone ASAR inspection never follows unpacked files outside the selected archive', async t => {
  const root = await scratch(t);
  const files = appFiles();
  const asar = await put(root, 'app.asar', makeAsar(files, new Set(['dist/main.js'])));
  const outside = path.join(root, 'outside');
  await put(outside, 'dist/main.js', files['dist/main.js']);
  await symlink(outside, `${asar}.unpacked`);
  await assert.rejects(inspectAsar(asar), /Not a real directory|Symlinked directory/u);
});

test('foreign native formats and script replacements for the installer are not macOS arm64 artifacts', async t => {
  assert.deepEqual(machOArchitectures(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), ['unsupported-elf']);
  const pe = Buffer.alloc(128);
  pe.writeUInt16LE(0x5a4d, 0);
  pe.writeUInt32LE(64, 60);
  pe.writeUInt32LE(0x00004550, 64);
  assert.deepEqual(machOArchitectures(pe), ['unsupported-pe']);
  const fixture = await releaseFixture(t);
  await put(fixture.appPath, 'Contents/Resources/rapp-work-installer', '#!/bin/sh\nexit 0\n', 0o755);
  await assert.rejects(scanApplication(fixture.appPath), /Required native component/u);
});

test('unknown app roots, arm64 replacements and escaping framework links cannot hide', async t => {
  const fixture = await releaseFixture(t);
  await put(fixture.appPath, 'outside.txt', 'unlisted');
  await assert.rejects(scanApplication(fixture.appPath), /Unallowlisted application/u);
  await rm(path.join(fixture.appPath, 'outside.txt'));
  const executable = await readFile(path.join(fixture.appPath, 'Contents/MacOS/RAPP Work'));
  executable.writeUInt32LE(0x01000007, 4);
  await put(fixture.appPath, 'Contents/MacOS/RAPP Work', executable, 0o755);
  await assert.rejects(scanApplication(fixture.appPath), /exclusively arm64|not an arm64/u);
  await rm(path.join(fixture.appPath, 'Contents/Frameworks/Electron Framework.framework'), { recursive: true });
  await symlink(path.dirname(fixture.appPath), path.join(fixture.appPath, 'Contents/Frameworks/Electron Framework.framework'));
  await assert.rejects(scanApplication(fixture.appPath), /Unsafe artifact symlink|Escaping artifact/u);
});
