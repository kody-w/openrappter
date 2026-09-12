import { copyFile, lstat, mkdir, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ARTIFACT_POLICY, REPOSITORY_ROOT, invariant, requireRealDirectory, validateMode } from './common.mjs';
import { AppleVerifier, command, requireMacArm64, validateTeamIdentifier } from './apple.mjs';
import { machOArchitectures } from './asar.mjs';
import { inventoryTree } from './inventory.mjs';
import { buildNativeInstaller } from './build-native.mjs';
import { captureBuildInputs, createProvenance, releaseFilename, writeBuildReceipt } from './provenance.mjs';
import { verifyPackagedDmg } from './installer.mjs';

async function signApplication(appPath, identity) {
  const inventory = await inventoryTree(appPath);
  const candidates = [appPath];
  for (const entry of inventory.entries) {
    const filename = path.join(appPath, entry.path);
    if (entry.type === 'directory' && /\.(?:app|framework|xpc)$/u.test(entry.path)) candidates.push(filename);
    if (entry.type === 'file' && machOArchitectures(await readFile(filename)).length) candidates.push(filename);
  }
  candidates.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const filename of candidates) {
    const args = ['--force', '--timestamp', '--options', 'runtime', '--sign', identity];
    if (filename.endsWith('.app')) args.push('--entitlements', path.join(REPOSITORY_ROOT, 'contracts/macos-entitlements.plist'));
    await command('/usr/bin/codesign', [...args, filename]);
  }
}

async function notarize(filename, profile) {
  const response = await command('/usr/bin/xcrun', [
    'notarytool', 'submit', filename, '--keychain-profile', profile, '--wait', '--output-format', 'json',
  ], { timeout: 30 * 60_000 });
  invariant(JSON.parse(response.stdout).status === 'Accepted', 'Apple did not accept the notarization submission');
}

export async function packageMacRelease({
  root = REPOSITORY_ROOT, appPath, outputDirectory, version, mode = 'production',
  signingIdentity, teamIdentifier, notaryProfile, privateKey, trustedPublicKey,
}) {
  requireMacArm64();
  validateMode(mode);
  invariant(appPath && outputDirectory, 'Select the new desktop application output and a release output directory');
  const sourceApp = await requireRealDirectory(appPath);
  await inventoryTree(sourceApp);
  const inputs = await captureBuildInputs(root, mode);
  if (mode === 'production') {
    validateTeamIdentifier(teamIdentifier);
    invariant(typeof signingIdentity === 'string' && signingIdentity.startsWith('Developer ID Application:'), 'A Developer ID Application identity is required');
    invariant(typeof notaryProfile === 'string' && /^[a-zA-Z0-9._-]+$/u.test(notaryProfile), 'An explicit notarytool keychain profile is required');
    invariant(privateKey && trustedPublicKey, 'Production requires independent signing and verification keys');
  } else invariant(!privateKey && !signingIdentity && !notaryProfile, 'Unsigned development cannot use production signing inputs');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const out = await requireRealDirectory(outputDirectory);
  const dmgPath = path.join(out, releaseFilename(version, mode));
  const manifestPath = `${dmgPath}.provenance.json`;
  const lock = path.join(out, '.rapp-work-packaging.lock');
  await mkdir(lock, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('A packaging operation already owns this output directory');
    throw error;
  });
  const staging = path.join(out, `.build-${randomUUID()}`);
  let complete = false;
  let ownsOutputs = false;
  try {
    for (const filename of [dmgPath, manifestPath]) {
      await lstat(filename).then(() => { throw new Error('Refusing to overwrite an existing release artifact'); }, error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    ownsOutputs = true;
    await mkdir(staging, { mode: 0o700 });
    const dmgRoot = path.join(staging, 'volume');
    await mkdir(dmgRoot);
    const packagedApp = path.join(dmgRoot, ARTIFACT_POLICY.applicationName);
    await command('/usr/bin/ditto', ['--rsrc', '--extattr', sourceApp, packagedApp]);
    await inventoryTree(packagedApp);
    await requireRealDirectory(path.join(packagedApp, 'Contents/Resources'));
    const helper = await buildNativeInstaller(path.join(staging, 'rapp-work-installer'));
    await copyFile(helper, path.join(packagedApp, 'Contents/Resources/rapp-work-installer'));
    await writeBuildReceipt(packagedApp, { version, mode, ...inputs });
    const apple = new AppleVerifier();
    if (mode === 'production') {
      await signApplication(packagedApp, signingIdentity);
      const archive = path.join(staging, 'application.zip');
      await command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', packagedApp, archive]);
      await notarize(archive, notaryProfile);
      await command('/usr/bin/xcrun', ['stapler', 'staple', packagedApp]);
    }
    await apple.application(packagedApp, { mode, teamIdentifier, version });
    await symlink('/Applications', path.join(dmgRoot, 'Applications'));
    await command('/usr/bin/hdiutil', [
      'create', '-volname', mode === 'production' ? 'RAPP Work' : 'RAPP Work - UNSIGNED DEVELOPMENT',
      '-srcfolder', dmgRoot, '-format', 'UDZO', '-fs', 'HFS+', dmgPath,
    ], { timeout: 10 * 60_000 });
    if (mode === 'production') {
      await command('/usr/bin/codesign', ['--force', '--timestamp', '--sign', signingIdentity, dmgPath]);
      await notarize(dmgPath, notaryProfile);
      await command('/usr/bin/xcrun', ['stapler', 'staple', dmgPath]);
    }
    const envelope = await createProvenance({
      root, appPath: packagedApp, dmgPath, version, mode, ...inputs, privateKey, teamIdentifier, apple,
    });
    await verifyPackagedDmg({
      root, dmgPath, envelope, mode, trustedPublicKey, teamIdentifier, expectedCommit: inputs.source.commit, mountDirectory: staging,
    });
    await writeFile(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    complete = true;
    return { dmgPath, manifestPath, mode, sourceCommit: inputs.source.commit };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (!complete && ownsOutputs) {
      await rm(dmgPath, { force: true });
      await rm(manifestPath, { force: true });
    }
    await rmdir(lock);
  }
}
