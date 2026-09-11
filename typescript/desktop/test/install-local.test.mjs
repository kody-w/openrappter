import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildDmg, installLocal, parseInstallArgs } from '../scripts/install-local.mjs';
import { desktopIdentity, dmgName, withMountedDmg } from '../scripts/release-contract.mjs';
import { appFixture, releaseFixture } from './release-test-support.mjs';

const versionAt = (app) => JSON.parse(fs.readFileSync(
  path.join(app, 'Contents', 'Info.plist'), 'utf8',
)).CFBundleShortVersionString;
const leftoverInstalls = (fixture) => fs.readdirSync(fixture.applications)
  .filter((name) => name.startsWith('.rapp-work-install'));

test('installation must be explicitly selected and options are strict', () => {
  assert.deepEqual(parseInstallArgs(['--dmg', 'image with spaces.dmg', '--replace']), {
    build: false, replace: true, dmg: 'image with spaces.dmg',
  });
  assert.equal(parseInstallArgs(['--build', '--arch', 'universal']).architecture, 'universal');
  for (const args of [[], ['--replace'], ['--build', '--dmg', 'x.dmg'], ['--dmg'], ['--dmg', '--replace'],
    ['--build', '--arch', '../../Applications'], ['--force'], ['--build', '--build'], ['--build', '--replace', '--replace']]) {
    assert.throws(() => parseInstallArgs(args));
  }
});

test('mocked fresh install mounts read-only, stages safely, unmounts, launches exact path, and reports version', async (t) => {
  const fixture = releaseFixture(t);
  const specialDmg = path.join(fixture.root, 'image with spaces; $(not-executed).dmg');
  fs.renameSync(fixture.dmg, specialDmg);
  const result = await installLocal({ dmg: specialDmg }, fixture.dependencies);
  assert.equal(result.path, fixture.destination);
  assert.equal(result.version, desktopIdentity().version);
  assert.equal(result.architecture, 'arm64');
  assert.equal(result.replaced, false);
  assert.equal(versionAt(fixture.destination), result.version);
  const attach = fixture.calls.find(({ args }) => args[0] === 'attach');
  for (const flag of ['-readonly', '-nobrowse', '-noautoopen', '-mountpoint', '-plist']) {
    assert.ok(attach.args.includes(flag));
  }
  assert.equal(attach.args.at(-1), specialDmg);
  const copied = fixture.calls.findIndex(({ command }) => command === '/usr/bin/ditto');
  const detached = fixture.calls.findIndex(({ args }) => args[0] === 'detach');
  const launched = fixture.calls.findIndex(({ command }) => command === '/usr/bin/open');
  assert.ok(copied >= 0 && detached > copied && launched > detached);
  assert.deepEqual(fixture.calls[launched].args, ['-n', fixture.destination]);
  assert.equal(fixture.calls.some(({ command }) => /sudo|rm|osascript|xattr/.test(command)), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('existing app requires --replace before build, mount, or command execution', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  await assert.rejects(installLocal({ build: true }, {
    ...fixture.dependencies,
    build: async () => { throw new Error('build must not run'); },
  }), /already exists; pass --replace/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(versionAt(fixture.destination), '1.0.0');
});

test('explicit replacement preserves unrelated and legacy apps and cleans only its own backup', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  const result = await installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies);
  assert.equal(result.replaced, true);
  assert.equal(versionAt(fixture.destination), desktopIdentity().version);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('foreign existing app, symlink destination, and running app are never replaced', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { CFBundleIdentifier: 'com.someone.else' });
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /CFBundleIdentifier/);
  fs.rmSync(fixture.destination, { recursive: true });
  fs.symlinkSync(fixture.source, fixture.destination, 'junction');
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /non-symlink directory/);
  fs.unlinkSync(fixture.destination);
  appFixture(fixture.destination);
  fixture.state.processes = `${fixture.destination}/Contents/MacOS/RAPP Work\n`;
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /Quit RAPP Work/);
  assert.equal(fixture.calls.some(({ args }) => args[0] === 'attach'), false);
});

test('symlink Applications directories and concurrent install locks fail without touching their targets', async (t) => {
  const fixture = releaseFixture(t);
  const linked = path.join(fixture.root, 'linked Applications');
  fs.symlinkSync(fixture.applications, linked, 'junction');
  await assert.rejects(installLocal({ dmg: fixture.dmg }, {
    ...fixture.dependencies, applicationsDirectory: linked,
  }), /non-symlink directory/);
  const lock = path.join(fixture.applications, '.rapp-work-install.lock');
  fs.mkdirSync(lock);
  await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /Another install or a stale lock/);
  assert.equal(fs.existsSync(lock), true);
  assert.deepEqual(fixture.calls, []);
});

test('wrong incoming bundle name, ID, executable, or architecture is rejected and unmounted', async (t) => {
  const fixture = releaseFixture(t);
  for (const overrides of [
    { CFBundleName: 'OpenRappter' },
    { CFBundleIdentifier: 'com.someone.else' },
    { CFBundleExecutable: '../../unrelated' },
    { architecture: 'x64' },
  ]) {
    appFixture(fixture.source, overrides);
    await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /Unexpected|not native/);
  }
  assert.equal(fixture.calls.filter(({ args }) => args[0] === 'detach').length, 4);
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/ditto'), false);
  assert.equal(fs.existsSync(fixture.destination), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('a DMG containing only the old app name is not treated as RAPP Work', async (t) => {
  const fixture = releaseFixture(t);
  fs.renameSync(fixture.source, path.join(fixture.volume, 'OpenRappter.app'));
  await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /ENOENT/);
  assert.ok(fixture.calls.some(({ args }) => args[0] === 'detach'));
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/ditto'), false);
});

test('native and universal supplied DMGs may report a version different from the checkout', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.source, { version: '2.0.0', architecture: 'universal' });
  const installed = await installLocal({ dmg: fixture.dmg }, fixture.dependencies);
  assert.equal(installed.version, '2.0.0');
  assert.equal(installed.architecture, 'universal');
});

test('checksum mismatch prevents mounting or staging', async (t) => {
  const fixture = releaseFixture(t);
  fs.writeFileSync(`${fixture.dmg}.sha256`, `${'0'.repeat(64)}  ${path.basename(fixture.dmg)}\n`);
  await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /DMG checksum mismatch/);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(fixture.destination), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('copy failure unmounts and leaves the existing installation intact', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  fixture.state.fail = (command) => command === '/usr/bin/ditto';
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /mock failure/);
  assert.equal(versionAt(fixture.destination), '1.0.0');
  assert.ok(fixture.calls.some(({ args }) => args[0] === 'detach'));
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('detach failure leaves the mount directory intact and cannot replace or launch an app', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  fixture.state.fail = (command, args) => command === '/usr/bin/hdiutil' && args[0] === 'detach';
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /Could not unmount/);
  const attach = fixture.calls.find(({ args }) => args[0] === 'attach');
  const mountPoint = attach.args[attach.args.indexOf('-mountpoint') + 1];
  assert.equal(fs.existsSync(path.join(mountPoint, desktopIdentity().bundleName)), true);
  assert.equal(versionAt(fixture.destination), '1.0.0');
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('failed attach still attempts detach, without launching or copying', async (t) => {
  const fixture = releaseFixture(t);
  fixture.state.fail = (command, args) => command === '/usr/bin/hdiutil' && args[0] === 'attach';
  await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /mock failure/);
  assert.ok(fixture.calls.some(({ args }) => args[0] === 'detach'));
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/ditto'), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('rename failure rolls back the verified existing app', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, {
    ...fixture.dependencies,
    rename: (from, to) => {
      if (to === fixture.destination && !from.includes(`${path.sep}previous${path.sep}`)) {
        throw new Error('rename failed');
      }
      fs.renameSync(from, to);
    },
  }), /rename failed/);
  assert.equal(versionAt(fixture.destination), '1.0.0');
  assert.deepEqual(leftoverInstalls(fixture), []);
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
});

test('validation failure after the rename restores the previous app', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  let installedNew = false;
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, {
    ...fixture.dependencies,
    rename: (from, to) => {
      fs.renameSync(from, to);
      if (to === fixture.destination && !from.includes(`${path.sep}previous${path.sep}`)) installedNew = true;
    },
    run: (command, args, options) => {
      const result = fixture.run(command, args, options);
      if (installedNew && command === '/usr/bin/plutil' &&
          args.at(-1) === path.join(fixture.destination, 'Contents', 'Info.plist')) {
        return JSON.stringify({ ...JSON.parse(result), CFBundleShortVersionString: 'invalid' });
      }
      return result;
    },
  }), /Unexpected app version/);
  assert.equal(versionAt(fixture.destination), '1.0.0');
  assert.deepEqual(leftoverInstalls(fixture), []);
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
});

test('failed rollback preserves the previous app and prints its recovery location', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, {
    ...fixture.dependencies,
    rename: (from, to) => {
      if (to === fixture.destination) throw new Error('rename unavailable');
      fs.renameSync(from, to);
    },
  }), /rename unavailable.*Previous app retained/);
  const [staging] = leftoverInstalls(fixture);
  assert.equal(versionAt(path.join(fixture.applications, staging, 'previous', desktopIdentity().bundleName)), '1.0.0');
  assert.equal(fs.existsSync(path.join(fixture.applications, '.rapp-work-install.lock')), false);
});

test('a DMG changed during staging cannot replace the existing app', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  fixture.state.afterDetach = () => fs.appendFileSync(fixture.dmg, 'changed');
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /DMG changed while staging/);
  assert.equal(versionAt(fixture.destination), '1.0.0');
  assert.deepEqual(leftoverInstalls(fixture), []);
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
});

test('an app appearing at the destination during staging is not overwritten', async (t) => {
  const fixture = releaseFixture(t);
  fixture.state.afterDetach = () => appFixture(fixture.destination, {
    CFBundleIdentifier: 'com.someone.else', version: '3.0.0',
  });
  await assert.rejects(installLocal({ dmg: fixture.dmg }, fixture.dependencies), /changed during staging/);
  assert.equal(versionAt(fixture.destination), '3.0.0');
  assert.equal(fixture.calls.some(({ command }) => command === '/usr/bin/open'), false);
  assert.deepEqual(leftoverInstalls(fixture), []);
});

test('launch failure reports the installed version and preserves the old app for recovery', async (t) => {
  const fixture = releaseFixture(t);
  appFixture(fixture.destination, { version: '1.0.0' });
  fixture.state.fail = (command) => command === '/usr/bin/open';
  await assert.rejects(installLocal({ dmg: fixture.dmg, replace: true }, fixture.dependencies), /Installed RAPP Work.*launch failed.*Previous app retained/);
  assert.equal(versionAt(fixture.destination), desktopIdentity().version);
  const [staging] = leftoverInstalls(fixture);
  assert.equal(versionAt(path.join(fixture.applications, staging, 'previous', desktopIdentity().bundleName)), '1.0.0');
  assert.equal(fs.existsSync(path.join(fixture.applications, '.rapp-work-install.lock')), false);
});

test('build mode refreshes core/runtime and packages the exact architecture with publishing disabled', async () => {
  const calls = [];
  const result = await buildDmg('arm64', {
    hostArchitecture: 'arm64',
    run: (command, args, options) => calls.push({ command, args, options }),
    generate: async (dmg, options) => {
      assert.equal(path.basename(dmg), dmgName('arm64'));
      assert.equal(options.architecture, 'arm64');
    },
  });
  assert.equal(path.basename(result), dmgName('arm64'));
  assert.deepEqual(calls[0].args, ['run', 'build']);
  assert.match(calls[1].args[0], /scripts[/\\]install-runtime\.mjs$/);
  assert.deepEqual(calls[2].args, [
    'run', 'dist', '--', '--mac', 'dmg', '--arm64',
    '--publish', 'never', '--config.mac.notarize=false',
  ]);
  assert.equal(calls[2].options.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(calls.some(({ args }) => args.includes('publish')), false);
});

test('local builds cannot silently ship host-only native dependencies under another architecture', async () => {
  for (const architecture of ['x64', 'universal']) {
    await assert.rejects(buildDmg(architecture, {
      hostArchitecture: 'arm64',
      run: () => { throw new Error('build must not run'); },
    }), /Local builds require native architecture arm64/);
  }
});

test('installer rejects non-macOS before native commands or filesystem mutations', async () => {
  await assert.rejects(installLocal({ dmg: 'irrelevant.dmg' }, { platform: 'linux' }), /requires macOS/);
  await assert.rejects(withMountedDmg('irrelevant.dmg', () => {}, { platform: 'win32' }), /require macOS/);
});
