import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DESKTOP_ROOT, TYPESCRIPT_ROOT, desktopIdentity, dmgName, inspectAppBundle,
  requireArchitecture, requirePlainPath, runCommand, statIfPresent,
  sha256File, verifyChecksumIfPresent, withMountedDmg,
} from './release-contract.mjs';
import { generateReleaseArtifacts } from './release-artifacts.mjs';

export function parseInstallArgs(args) {
  const options = { replace: false, build: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--replace') options.replace = true;
    else if (arg === '--build') options.build = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--dmg' || arg === '--arch') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[arg === '--dmg' ? 'dmg' : 'architecture'] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.architecture !== undefined) requireArchitecture(options.architecture);
  if (!options.help && Number(options.build) + Number(Boolean(options.dmg)) !== 1) {
    throw new Error('Choose exactly one of --build or --dmg FILE; installation is never implicit.');
  }
  return options;
}

export async function buildDmg(architecture, {
  run = runCommand,
  generate = generateReleaseArtifacts,
  hostArchitecture = process.arch,
} = {}) {
  requireArchitecture(architecture);
  if (architecture !== hostArchitecture) {
    throw new Error(`Local builds require native architecture ${hostArchitecture}; cross/universal builds need separately built native runtime dependencies.`);
  }
  const buildOptions = { timeout: 30 * 60_000, stdio: 'inherit' };
  run('npm', ['run', 'build'], { ...buildOptions, cwd: TYPESCRIPT_ROOT });
  run(process.execPath, [path.join(DESKTOP_ROOT, 'scripts', 'install-runtime.mjs')], {
    ...buildOptions, cwd: DESKTOP_ROOT,
  });
  run('npm', [
    'run', 'dist', '--', '--mac', 'dmg', `--${architecture}`,
    '--publish', 'never', '--config.mac.notarize=false',
  ], {
    ...buildOptions, cwd: DESKTOP_ROOT,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  const dmg = path.join(DESKTOP_ROOT, 'dist', dmgName(architecture));
  await generate(dmg, { architecture, run });
  return dmg;
}

function assertNotRunning(destination, run) {
  const prefix = `${destination}/Contents/`;
  const processes = run('/bin/ps', ['-axo', 'comm=']).split('\n');
  if (processes.some((command) => command.trim().startsWith(prefix))) {
    throw new Error(`Quit ${desktopIdentity().productName} before replacing ${destination}.`);
  }
}

function sameEntry(left, right) {
  return left === null ? right === null
    : right !== null && left.dev === right.dev && left.ino === right.ino;
}

export async function installLocal(options, {
  run = runCommand,
  mount = withMountedDmg,
  build = buildDmg,
  platform = process.platform,
  hostArchitecture = process.arch,
  applicationsDirectory = '/Applications',
  rename = fs.renameSync,
} = {}) {
  if (platform !== 'darwin') throw new Error('Local DMG installation requires macOS.');
  if (Number(Boolean(options.build)) + Number(Boolean(options.dmg)) !== 1) {
    throw new Error('Choose exactly one of --build or --dmg FILE.');
  }
  requirePlainPath(applicationsDirectory, 'isDirectory');
  const destination = path.join(applicationsDirectory, desktopIdentity().bundleName);
  const original = statIfPresent(destination);
  let originalVersion;
  if (original) {
    if (!options.replace) throw new Error(`${destination} already exists; pass --replace to replace only this app.`);
    originalVersion = inspectAppBundle(destination, { run }).version;
    assertNotRunning(destination, run);
  }
  const lock = path.join(applicationsDirectory, '.rapp-work-install.lock');
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    throw new Error(error.code === 'EEXIST'
      ? `Another install or a stale lock exists at ${lock}; no app was changed.`
      : `Cannot write to ${applicationsDirectory}; use an authorized local account. No sudo or permission prompt is attempted.`);
  }

  let staging;
  let stagedApp;
  let backup;
  let complete = false;
  try {
    const dmg = path.resolve(options.build
      ? await build(options.architecture ?? hostArchitecture, { run, hostArchitecture })
      : options.dmg);
    requirePlainPath(dmg, 'isFile');
    const checksum = await verifyChecksumIfPresent(dmg);
    const source = await mount(dmg, (app) => {
      const identity = inspectAppBundle(app, { run });
      if (identity.architecture !== 'universal' && identity.architecture !== hostArchitecture) {
        throw new Error(`DMG architecture ${identity.architecture} is not native to this ${hostArchitecture} Mac.`);
      }
      if (options.architecture !== undefined && identity.architecture !== options.architecture) {
        throw new Error(`DMG architecture ${identity.architecture} does not match --arch ${options.architecture}.`);
      }
      staging = path.join(applicationsDirectory, `.rapp-work-install-${randomUUID()}`);
      fs.mkdirSync(staging, { mode: 0o700 });
      stagedApp = path.join(staging, desktopIdentity().bundleName);
      run('/usr/bin/ditto', [app, stagedApp], { timeout: 10 * 60_000 });
      const staged = inspectAppBundle(stagedApp, { run, version: identity.version });
      if (staged.architecture !== identity.architecture) throw new Error('Architecture changed while copying the app.');
      return identity;
    }, { run, platform });

    // Finish the read-only mount before the atomic rename, so an unmount
    // failure cannot remove or replace a user's existing installation.
    if (await sha256File(dmg) !== checksum) {
      throw new Error('DMG changed while staging; no installation was replaced.');
    }
    if (!sameEntry(original, statIfPresent(destination))) {
      throw new Error(`${destination} changed during staging; refusing to overwrite it.`);
    }
    if (original) {
      inspectAppBundle(destination, { run, version: originalVersion });
      assertNotRunning(destination, run);
      const previous = path.join(staging, 'previous');
      fs.mkdirSync(previous);
      backup = path.join(previous, desktopIdentity().bundleName);
      rename(destination, backup);
    }
    let movedNew = false;
    let installed;
    try {
      rename(stagedApp, destination);
      movedNew = true;
      installed = inspectAppBundle(destination, { run, version: source.version });
      if (installed.architecture !== source.architecture) throw new Error('Installed app architecture changed.');
    } catch (error) {
      if (movedNew) rename(destination, stagedApp);
      if (backup && !statIfPresent(destination)) rename(backup, destination);
      throw error;
    }
    try {
      run('/usr/bin/open', ['-n', destination]);
    } catch (error) {
      throw new Error(`Installed ${installed.productName} ${installed.version}, but launch failed: ${error.message}`);
    }
    complete = true;
    return { ...installed, path: destination, replaced: Boolean(original) };
  } catch (error) {
    if (backup && statIfPresent(backup)) {
      throw new Error(`${error.message} Previous app retained at ${backup}.`);
    }
    throw error;
  } finally {
    if (staging && (complete || !backup || !statIfPresent(backup))) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    fs.rmdirSync(lock);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/install-local.mjs (--build | --dmg FILE) [--arch arm64|x64|universal] [--replace]');
    } else {
      const result = await installLocal(options);
      console.log(`Installed ${result.productName} ${result.version} (${result.architecture}) at ${result.path}; launched.`);
    }
  } catch (error) {
    console.error(`Local install: ${error.message}`);
    process.exitCode = 1;
  }
}
