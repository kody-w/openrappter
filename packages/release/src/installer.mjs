import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_POLICY, canonical, invariant, requireRealDirectory, validateMode } from './common.mjs';
import { AppleVerifier, command, requireMacArm64 } from './apple.mjs';
import { fileDigest, inventoryTree, verifySource } from './inventory.mjs';
import { verifyApplication, verifyDmgBytes, verifyProvenance } from './provenance.mjs';

const TRANSACTION = /^\.rapp-work-transaction-[a-f0-9-]{36}$/u;
const HELPER = 'Contents/Resources/rapp-work-installer';
const RECEIPT = 'Contents/Resources/rapp-work-build.json';

function applicationName(mode) {
  return mode === 'production' ? ARTIFACT_POLICY.applicationName : ARTIFACT_POLICY.developmentApplicationName;
}

async function exists(filename) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJournal(transaction, journal) {
  const next = path.join(transaction, `journal-${randomUUID()}.next`);
  const handle = await open(next, 'wx', 0o600);
  try {
    await handle.writeFile(`${canonical(journal)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(next, path.join(transaction, 'journal.json'));
  await syncDirectory(transaction);
}

async function withInstallLock(applicationsDirectory, callback) {
  const root = await requireRealDirectory(applicationsDirectory);
  invariant(((await lstat(root)).mode & 0o002) === 0, 'Applications directory must not be world-writable');
  const lock = path.join(root, '.rapp-work-install.lock');
  await mkdir(lock, { mode: 0o700 }).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another installation or recovery holds the install lock; do not remove it automatically');
    throw error;
  });
  try { return await callback(root); } finally { await rmdir(lock); }
}

async function installedDigest(destination) {
  const stat = await exists(destination);
  if (!stat) return null;
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), 'An application destination must not be a symlink or non-directory');
  return (await inventoryTree(destination)).digest;
}

async function previousApplication(destination, { mode, teamIdentifier, apple }) {
  const digest = await installedDigest(destination);
  if (!digest) return null;
  const receipt = JSON.parse(await readFile(path.join(destination, RECEIPT), 'utf8'));
  invariant(receipt.product === 'RAPP Work' && receipt.mode === mode, 'Refusing to replace an unrelated application or cross production/development modes');
  await apple.application(destination, { mode, teamIdentifier, version: receipt.version });
  return { digest, version: receipt.version, mode };
}

async function copyApplication(source, destination) {
  await command('/usr/bin/ditto', ['--rsrc', '--extattr', source, destination]);
}

async function assertNotRunning(destination) {
  const processes = await command('/bin/ps', ['-axo', 'comm=']);
  invariant(!processes.stdout.split('\n').some(line => line.trim().startsWith(`${destination}/Contents/`)), 'Quit RAPP Work before replacing or rolling it back');
}

async function nativeOperator(transaction, envelope) {
  requireMacArm64();
  const helper = path.join(transaction, 'rapp-work-installer');
  const expected = envelope.payload.app.entries.find(entry => entry.path === HELPER && entry.type === 'file');
  invariant(expected && (await fileDigest(helper)).sha256 === expected.sha256, 'Transaction installer helper does not match the verified artifact');
  return async (operation, source, destination) => {
    invariant(['move', 'swap'].includes(operation), 'Unknown atomic operation');
    const response = await command(helper, [operation, source, destination]);
    const result = JSON.parse(response.stdout);
    invariant(result.schema === 'rapp-work.atomic-replace/1' && result.committed === true, 'Atomic replacement did not return a committed receipt');
  };
}

function dependencies(options) {
  return {
    apple: options.apple ?? new AppleVerifier(),
    copy: options.copy ?? copyApplication,
    notRunning: options.notRunning ?? assertNotRunning,
    operatorFactory: options.operatorFactory ?? nativeOperator,
  };
}

async function rollbackKnownState(root, transaction, journal, atomic, deps, trust) {
  const destination = path.join(root, applicationName(journal.mode));
  const candidate = path.join(transaction, ARTIFACT_POLICY.applicationName);
  const current = await installedDigest(destination);
  const staged = await installedDigest(candidate);
  if (current === (journal.previous?.digest ?? null) && staged === journal.envelope.payload.app.digest) {
    journal.state = 'rolled-back';
    await writeJournal(transaction, journal);
    return;
  }
  invariant(current === journal.envelope.payload.app.digest, 'Recovery stopped: destination no longer matches either recorded application');
  invariant(staged === (journal.previous?.digest ?? null), 'Recovery stopped: rollback application no longer matches its recorded digest');
  if (journal.previous) {
    await deps.apple.application(candidate, { mode: journal.mode, teamIdentifier: trust.teamIdentifier, version: journal.previous.version });
    await atomic('swap', candidate, destination);
  } else {
    await atomic('move', destination, candidate);
  }
  invariant(await installedDigest(destination) === (journal.previous?.digest ?? null), 'Rollback verification failed; preserve the transaction for recovery');
  journal.state = 'rolled-back';
  await writeJournal(transaction, journal);
}

export async function installApplication(options) {
  const { appPath, envelope, applicationsDirectory, mode = 'production', ...rest } = options;
  validateMode(mode);
  invariant(applicationsDirectory, 'An explicit applications directory is required');
  const deps = dependencies(options);
  const trust = { mode, trustedPublicKey: rest.trustedPublicKey, teamIdentifier: rest.teamIdentifier, expectedCommit: rest.expectedCommit };
  await verifyApplication(appPath, envelope, { ...trust, apple: deps.apple });
  return withInstallLock(applicationsDirectory, async root => {
    const destination = path.join(root, applicationName(mode));
    await deps.notRunning(destination);
    const previous = await previousApplication(destination, { mode, teamIdentifier: trust.teamIdentifier, apple: deps.apple });
    const transaction = path.join(root, `.rapp-work-transaction-${randomUUID()}`);
    await mkdir(transaction, { mode: 0o700 });
    const candidate = path.join(transaction, ARTIFACT_POLICY.applicationName);
    const journal = { schema: 'rapp-work.installation/1', mode, state: 'preparing', previous, envelope };
    let atomic;
    try {
      await deps.copy(appPath, candidate);
      await verifyApplication(candidate, envelope, { ...trust, apple: deps.apple });
      await copyFile(path.join(candidate, HELPER), path.join(transaction, 'rapp-work-installer'));
      await chmod(path.join(transaction, 'rapp-work-installer'), 0o700);
      atomic = await deps.operatorFactory(transaction, envelope);
      journal.state = 'prepared';
      await writeJournal(transaction, journal);
      await atomic(previous ? 'swap' : 'move', candidate, destination);
      journal.state = 'swapped';
      await writeJournal(transaction, journal);
      await verifyApplication(destination, envelope, { ...trust, apple: deps.apple });
      if (previous) invariant(await installedDigest(candidate) === previous.digest, 'Rollback copy changed during replacement');
      journal.state = 'committed';
      await writeJournal(transaction, journal);
      return { status: 'installed', mode, destination, journalPath: path.join(transaction, 'journal.json'), rollbackAvailable: previous !== null };
    } catch (error) {
      if (atomic) {
        try {
          await rollbackKnownState(root, transaction, journal, atomic, deps, trust);
        } catch (recoveryError) {
          journal.state = 'unresolved';
          await writeJournal(transaction, journal);
          throw new AggregateError([error, recoveryError], `Installation is unresolved; preserve ${transaction} and run explicit recovery`);
        }
      } else {
        journal.state = 'not-installed';
        await writeJournal(transaction, journal);
      }
      throw error;
    }
  });
}

export async function rollbackInstallation({ journalPath, applicationsDirectory, mode = 'production', ...options }) {
  validateMode(mode);
  const deps = dependencies(options);
  return withInstallLock(applicationsDirectory, async root => {
    const transaction = path.dirname(path.resolve(journalPath));
    invariant(path.dirname(transaction) === root && TRANSACTION.test(path.basename(transaction)), 'Journal must belong to this applications directory');
    invariant(path.basename(journalPath) === 'journal.json' && await realpath(transaction) === transaction, 'Unsafe installation journal path');
    const stat = await lstat(journalPath);
    invariant(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'Installation journal must be a private regular file');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    invariant(journal.schema === 'rapp-work.installation/1' && journal.mode === mode, 'Installation journal identity or mode mismatch');
    const trust = { mode, trustedPublicKey: options.trustedPublicKey, teamIdentifier: options.teamIdentifier, expectedCommit: options.expectedCommit };
    verifyProvenance(journal.envelope, trust);
    const destination = path.join(root, applicationName(mode));
    await deps.notRunning(destination);
    const atomic = await deps.operatorFactory(transaction, journal.envelope);
    await rollbackKnownState(root, transaction, journal, atomic, deps, trust);
    return { status: 'rolled-back', destination, journalPath };
  });
}

export const recoverInstallation = rollbackInstallation;

async function withMountedArtifact(options, callback) {
  const { dmgPath, envelope, mountDirectory, mode = 'production' } = options;
  requireMacArm64();
  const trust = { mode, trustedPublicKey: options.trustedPublicKey, teamIdentifier: options.teamIdentifier, expectedCommit: options.expectedCommit };
  await verifyDmgBytes(dmgPath, envelope, trust);
  const apple = options.apple ?? new AppleVerifier();
  await apple.dmg(dmgPath, { mode, teamIdentifier: options.teamIdentifier });
  const root = await requireRealDirectory(mountDirectory);
  const mount = path.join(root, `.rapp-work-mount-${randomUUID()}`);
  await mkdir(mount, { mode: 0o700 });
  let attached = false;
  try {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmgPath]);
    attached = true;
    const contents = (await readdir(mount)).sort();
    invariant(contents.every(name => [ARTIFACT_POLICY.applicationName, 'Applications', '.fseventsd', '.Trashes', '.DS_Store'].includes(name)), 'DMG contains an unallowlisted top-level resource');
    for (const metadata of ['.fseventsd', '.Trashes']) {
      if (contents.includes(metadata)) {
        const metadataPath = path.join(mount, metadata);
        invariant((await lstat(metadataPath)).isDirectory(), 'Unexpected DMG metadata type');
        const names = await readdir(metadataPath);
        invariant(names.every(name => metadata === '.fseventsd' && ['no_log', 'fseventsd-uuid'].includes(name)), 'DMG metadata contains unallowlisted payloads');
      }
    }
    const link = path.join(mount, 'Applications');
    const linkStat = await exists(link);
    if (linkStat) invariant(linkStat.isSymbolicLink() && await realpath(link) === '/Applications', 'Unexpected DMG Applications link');
    const appPath = path.join(mount, ARTIFACT_POLICY.applicationName);
    await verifyApplication(appPath, envelope, { ...trust, apple });
    return await callback(appPath, apple);
  } finally {
    if (attached) await command('/usr/bin/hdiutil', ['detach', mount]);
    await rmdir(mount);
  }
}

export async function verifyPackagedDmg(options) {
  return withMountedArtifact(options, async () => {
    if (options.root) {
      await verifySource(options.root, options.envelope.payload.source);
      invariant((await inventoryTree(path.join(options.root, ARTIFACT_POLICY.canonicalFixturesRoot))).digest === options.envelope.payload.fixtures.digest, 'Packaged canonical fixture digest mismatch');
    }
    return { status: 'verified', mode: options.envelope.payload.mode, dmgDigest: options.envelope.payload.dmg.sha256, appDigest: options.envelope.payload.app.digest };
  });
}

export async function installDmg(options) {
  return withMountedArtifact({ ...options, mountDirectory: options.applicationsDirectory }, (appPath, apple) => installApplication({ ...options, appPath, apple }));
}
