import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DESKTOP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..',
);
export const TYPESCRIPT_ROOT = path.dirname(DESKTOP_ROOT);
export const REPOSITORY_ROOT = path.dirname(TYPESCRIPT_ROOT);
export const ARCHITECTURES = ['arm64', 'x64', 'universal'];

export function desktopIdentity() {
  const metadata = JSON.parse(fs.readFileSync(
    path.join(DESKTOP_ROOT, 'package.json'), 'utf8',
  ));
  return {
    productName: metadata.build.productName,
    packageName: metadata.name,
    version: metadata.version,
    appId: metadata.build.appId,
    bundleName: `${metadata.build.productName}.app`,
    executableName: metadata.build.mac.executableName,
  };
}

export function requireArchitecture(architecture) {
  if (!ARCHITECTURES.includes(architecture)) {
    throw new Error(`Unsupported architecture: ${architecture}; use ${ARCHITECTURES.join(', ')}.`);
  }
  return architecture;
}

export function dmgName(architecture, identity = desktopIdentity()) {
  requireArchitecture(architecture);
  return `${identity.productName}-${identity.version}-mac-${architecture}.dmg`;
}

export function macAppPath(outputDirectory, architecture) {
  requireArchitecture(architecture);
  const directory = architecture === 'x64' ? 'mac' : `mac-${architecture}`;
  return path.join(outputDirectory, directory, desktopIdentity().bundleName);
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    ...options,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.signal ?? 'unknown'}): ` +
      `${result.stderr || result.stdout || 'no diagnostic output'}`,
    );
  }
  return result.stdout ?? '';
}

export function statIfPresent(filename) {
  try {
    return fs.lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function requirePlainPath(filename, type) {
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink() || !stat[type]()) {
    throw new Error(`Expected a non-symlink ${type === 'isDirectory' ? 'directory' : 'file'}: ${filename}`);
  }
  return stat;
}

export function writeRegularFile(filename, contents) {
  if (statIfPresent(filename)) requirePlainPath(filename, 'isFile');
  const fd = fs.openSync(filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o644,
  );
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

export function inspectAppBundle(appPath, { run = runCommand, version } = {}) {
  const identity = desktopIdentity();
  if (path.basename(appPath) !== identity.bundleName) {
    throw new Error(`Expected ${identity.bundleName}, not ${path.basename(appPath)}.`);
  }
  for (const directory of [appPath, path.join(appPath, 'Contents'), path.join(appPath, 'Contents', 'MacOS')]) {
    requirePlainPath(directory, 'isDirectory');
  }
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  requirePlainPath(plist, 'isFile');
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
  const expected = {
    CFBundleIdentifier: identity.appId,
    CFBundleName: identity.productName,
    CFBundleExecutable: identity.executableName,
    CFBundlePackageType: 'APPL',
  };
  if (info.CFBundleDisplayName !== undefined) {
    expected.CFBundleDisplayName = identity.productName;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (info[key] !== value) {
      throw new Error(`Unexpected ${key}: expected ${value}, received ${info[key]}.`);
    }
  }
  const installedVersion = info.CFBundleShortVersionString;
  if (typeof installedVersion !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(installedVersion) ||
      (version !== undefined && installedVersion !== version)) {
    throw new Error(`Unexpected app version: ${installedVersion}${version ? `; expected ${version}` : ''}.`);
  }
  const executable = path.join(appPath, 'Contents', 'MacOS', identity.executableName);
  requirePlainPath(executable, 'isFile');
  fs.accessSync(executable, fs.constants.X_OK);
  const arches = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/).sort().join(' ');
  const architecture = {
    arm64: 'arm64',
    x86_64: 'x64',
    'arm64 x86_64': 'universal',
  }[arches];
  if (!architecture) throw new Error(`Unexpected executable architectures: ${arches}.`);
  return { ...identity, version: installedVersion, architecture, executable };
}

export async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyChecksumIfPresent(dmg) {
  const checksum = await sha256File(dmg);
  const checksumPath = `${dmg}.sha256`;
  if (!statIfPresent(checksumPath)) return checksum;
  requirePlainPath(checksumPath, 'isFile');
  if (fs.readFileSync(checksumPath, 'utf8') !== `${checksum}  ${path.basename(dmg)}\n`) {
    throw new Error(`DMG checksum mismatch: ${checksumPath}`);
  }
  return checksum;
}

export async function withMountedDmg(dmg, action, {
  run = runCommand,
  platform = process.platform,
  scratchRoot = path.join(DESKTOP_ROOT, 'dist'),
} = {}) {
  if (platform !== 'darwin') throw new Error('DMG verification and installation require macOS.');
  dmg = path.resolve(dmg);
  requirePlainPath(dmg, 'isFile');
  if (path.extname(dmg) !== '.dmg') throw new Error(`Expected a .dmg file: ${dmg}`);
  run('/usr/bin/hdiutil', ['verify', dmg], { timeout: 10 * 60_000 });
  fs.mkdirSync(scratchRoot, { recursive: true });
  const session = path.join(scratchRoot, `.rapp-work-mount-${randomUUID()}`);
  fs.mkdirSync(session, { mode: 0o700 });
  const mountPoint = path.join(session, 'volume');
  fs.mkdirSync(mountPoint);
  let attached = false;
  let result;
  let failure;
  try {
    run('/usr/bin/hdiutil', [
      'attach', '-readonly', '-nobrowse', '-noautoopen',
      '-mountpoint', mountPoint, '-plist', dmg,
    ], { timeout: 10 * 60_000 });
    attached = true;
    result = await action(path.join(mountPoint, desktopIdentity().bundleName));
  } catch (error) {
    failure = error;
  }
  try {
    // Also attempt cleanup after a partially failed attach. Never recurse into
    // a mount whose detach failed.
    run('/usr/bin/hdiutil', ['detach', mountPoint]);
    fs.rmSync(session, { recursive: true });
  } catch (error) {
    if (attached || !failure) {
      throw new Error(
        `${failure ? `${failure.message} ` : ''}Could not unmount ${mountPoint}; ` +
        `left the mount directory intact. ${error.message}`,
      );
    }
    failure = new Error(`${failure.message} Cleanup could not confirm unmount of ${mountPoint}; left it intact.`);
  }
  if (failure) throw failure;
  return result;
}
