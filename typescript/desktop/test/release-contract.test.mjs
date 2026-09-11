import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  desktopIdentity, dmgName, inspectAppBundle, macAppPath, runCommand,
} from '../scripts/release-contract.mjs';
import { releaseFixture } from './release-test-support.mjs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const require = createRequire(new URL('../../package.json', import.meta.url));
const { parse } = require('yaml');
const workflow = (name) => parse(readFileSync(
  new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8',
));

test('RAPP Work packaging changes display names, not compatibility identifiers', () => {
  assert.equal(metadata.build.productName, 'RAPP Work');
  assert.equal(metadata.build.appId, 'com.openrappter.desktop');
  assert.equal(metadata.name, 'openrappter-desktop');
  assert.equal(metadata.productName, undefined);
  assert.equal(lock.name, metadata.name);
  assert.equal(lock.version, metadata.version);
  assert.equal(lock.packages[''].version, metadata.version);
  assert.equal(metadata.build.mac.executableName, 'RAPP Work');
  assert.equal(metadata.build.win.executableName, 'OpenRappter');
  assert.equal(metadata.build.linux.executableName, 'openrappter');
  assert.match(metadata.description, /RAPP Work/);
  for (const description of Object.values(metadata.build.mac.extendInfo)) {
    assert.match(description, /RAPP Work/);
    assert.doesNotMatch(description, /OpenRappter/);
  }
  assert.equal(metadata.build.afterPack, 'scripts/release-artifacts.mjs');
  assert.match(metadata.scripts.dist, /--publish never/);
});

test('macOS discovery and artifact names use exact RAPP Work names for every architecture', (t) => {
  const fixture = releaseFixture(t);
  for (const [arch, directory] of [['arm64', 'mac-arm64'], ['x64', 'mac'], ['universal', 'mac-universal']]) {
    assert.equal(macAppPath('dist', arch), path.join('dist', directory, 'RAPP Work.app'));
    assert.equal(dmgName(arch), `RAPP Work-${metadata.version}-mac-${arch}.dmg`);
  }
  const discovered = inspectAppBundle(fixture.source, { run: fixture.run });
  assert.equal(discovered.executable, path.join(fixture.source, 'Contents', 'MacOS', 'RAPP Work'));
  assert.equal(discovered.appId, desktopIdentity().appId);
  assert.throws(() => inspectAppBundle(path.join(fixture.volume, 'OpenRappter.app')), /Expected RAPP Work.app/);
  assert.throws(() => dmgName('../../outside'), /Unsupported architecture/);
});

test('native command runner preserves spaces and shell metacharacters as literal arguments', () => {
  const argument = 'RAPP Work; $(not-a-command) with spaces';
  const output = runCommand(process.execPath, [
    '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', argument,
  ]);
  assert.deepEqual(JSON.parse(output), [argument]);
  assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(7)']), /failed \(7\)/);
});

test('local installer help and invalid input never invoke installation', () => {
  const script = new URL('../scripts/install-local.mjs', import.meta.url);
  const help = spawnSync(process.execPath, [script.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--replace/);
  const invalid = spawnSync(process.execPath, [script.pathname], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /installation is never implicit/);
});

test('release workflow discovers RAPP Work and gates upload on verified manifests', () => {
  const release = workflow('release');
  const steps = release.jobs['build-electron-artifacts'].steps;
  const smoke = steps.find((step) => step.name === 'Smoke packaged macOS application');
  const signing = steps.find((step) => step.name === 'Require signed and notarized macOS release');
  assert.match(smoke.run, /RAPP Work\.app\/Contents\/MacOS\/RAPP Work/);
  assert.match(signing.run, /-name 'RAPP Work\.app'/);
  assert.doesNotMatch(`${smoke.run}\n${signing.run}`, /OpenRappter\.app/);
  const generate = steps.findIndex((step) => step.run === 'npm run release:manifest -- --require-clean');
  const upload = steps.findIndex((step) => step.name === 'Upload desktop distributions');
  assert.ok(generate > steps.indexOf(signing) && upload > generate);
  assert.equal(steps[generate].if, "matrix.os == 'mac'");
  assert.equal(steps[upload].with['if-no-files-found'], 'error');
  for (const suffix of ['*.dmg', '*.dmg.sha256', '*.dmg.manifest.json']) {
    assert.ok(steps[upload].with.path.split('\n').includes(`typescript/desktop/dist/${suffix}`));
    const publish = release.jobs['github-release'].steps.find((step) => step.with?.files);
    assert.ok(publish.with.files.split('\n').includes(`desktop-dist/${suffix}`));
  }
  const checksum = release.jobs['github-release'].steps.find((step) => step.name === 'Generate desktop checksums');
  assert.match(checksum.run, /sha256sum --check \.\/\*\.dmg\.sha256/);
});

test('desktop CI builds and uploads verified DMG sidecars without publishing or installing', () => {
  const ci = workflow('desktop');
  const steps = ci.jobs.desktop.steps;
  const build = steps.findIndex((step) => step.name === 'Build macOS DMG without publishing');
  const generate = steps.findIndex((step) => step.run === 'npm run release:manifest -- --require-clean');
  const upload = steps.findIndex((step) => step.name === 'Upload RAPP Work macOS artifacts');
  assert.ok(build >= 0 && generate > build && upload > generate);
  assert.match(steps[build].run, /npm run dist -- --mac dmg/);
  for (const index of [build, generate, upload]) assert.equal(steps[index].if, "runner.os == 'macOS'");
  assert.equal(steps[upload].with['if-no-files-found'], 'error');
  for (const suffix of ['*.dmg', '*.dmg.sha256', '*.dmg.manifest.json']) {
    assert.ok(steps[upload].with.path.split('\n').includes(`typescript/desktop/dist/${suffix}`));
  }
  assert.doesNotMatch(steps.map((step) => step.run ?? '').join('\n'), /install:local|install-local|--publish always|--publish onTag/);
  assert.equal(ci.permissions.contents, 'read');
});
