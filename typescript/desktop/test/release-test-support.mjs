import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopIdentity, dmgName, withMountedDmg } from '../scripts/release-contract.mjs';

const SCRATCH = fileURLToPath(new URL('../.test-scratch/', import.meta.url));

export function appFixture(app, { version = desktopIdentity().version, architecture = 'arm64', ...overrides } = {}) {
  const identity = desktopIdentity();
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), JSON.stringify({
    CFBundleName: identity.productName,
    CFBundleDisplayName: identity.productName,
    CFBundleIdentifier: identity.appId,
    CFBundleExecutable: identity.executableName,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    ...overrides,
  }));
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', identity.executableName), {
    arm64: 'arm64', x64: 'x86_64', universal: 'arm64 x86_64',
  }[architecture] ?? architecture, { mode: 0o755 });
  return app;
}

export function releaseFixture(t) {
  const root = path.join(SCRATCH, `release-${randomUUID()}`);
  const applications = path.join(root, 'Applications with spaces');
  const volume = path.join(root, 'image contents');
  const source = path.join(volume, desktopIdentity().bundleName);
  const destination = path.join(applications, desktopIdentity().bundleName);
  const dmg = path.join(root, dmgName('arm64'));
  const unrelated = ['Other.app', 'OpenRappter.app'].map((name) => path.join(applications, name, 'keep'));
  fs.mkdirSync(applications, { recursive: true });
  for (const marker of unrelated) {
    fs.mkdirSync(path.dirname(marker));
    fs.writeFileSync(marker, 'untouched');
  }
  appFixture(source);
  fs.writeFileSync(dmg, 'deterministic DMG test bytes');
  const calls = [];
  const state = { fail: null, afterDetach: null, gitDirty: false };
  function run(command, args, options = {}) {
    calls.push({ command, args: [...args], options });
    if (state.fail?.(command, args)) throw new Error(`mock failure: ${command} ${args[0]}`);
    if (command === '/usr/bin/plutil') return fs.readFileSync(args.at(-1), 'utf8');
    if (command === '/usr/bin/lipo') return fs.readFileSync(args.at(-1), 'utf8');
    if (command === '/bin/ps') return state.processes ?? '';
    if (command === '/usr/bin/ditto') {
      fs.cpSync(args[0], args[1], { recursive: true });
      return '';
    }
    if (command === '/usr/bin/hdiutil') {
      if (args[0] === 'attach') {
        const mountPoint = args[args.indexOf('-mountpoint') + 1];
        fs.cpSync(volume, mountPoint, { recursive: true });
      } else if (args[0] === 'detach') {
        fs.rmSync(args[1], { recursive: true, force: true });
        fs.mkdirSync(args[1]);
        state.afterDetach?.();
      }
      return '';
    }
    if (command === '/usr/bin/open') return '';
    if (command === 'git') return args[0] === 'rev-parse'
      ? `${'a'.repeat(40)}\n` : state.gitDirty ? ' M modified-file\n' : '';
    throw new Error(`Unmocked command forbidden: ${command}`);
  }
  const mount = (image, action) => withMountedDmg(image, action, {
    run, platform: 'darwin', scratchRoot: path.join(root, 'mounts'),
  });
  const dependencies = {
    run, mount, platform: 'darwin', hostArchitecture: 'arm64',
    applicationsDirectory: applications,
  };
  t.after(() => {
    try {
      for (const marker of unrelated) assert.equal(fs.readFileSync(marker, 'utf8'), 'untouched');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, applications, volume, source, destination, dmg, calls, state, run, mount, dependencies };
}
