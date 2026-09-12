import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inventoryTree } from '../src/inventory.mjs';
import { installApplication, recoverInstallation, rollbackInstallation } from '../src/installer.mjs';
import { releaseFixture, scratch, TestAppleVerifier } from './helpers.mjs';

function testOperations(apple = new TestAppleVerifier()) {
  const operations = [];
  const executeAtomic = async (operation, source, destination) => {
    operations.push({ operation, source, destination });
    if (operation === 'move') {
      await assert.rejects(lstat(destination), /ENOENT/u);
      await rename(source, destination);
    } else {
      const held = path.join(path.dirname(source), 'exchange.app');
      await rename(source, held);
      await rename(destination, source);
      await rename(held, destination);
    }
  };
  return {
    operations, apple,
    copy: (source, destination) => cp(source, destination, { recursive: true, verbatimSymlinks: true }),
    notRunning: async () => {},
    operatorFactory: async () => executeAtomic,
    executeAtomic,
  };
}

async function optionsFor(t, fixture, overrides = {}) {
  const applicationsDirectory = path.join(await scratch(t), 'Applications');
  await mkdir(applicationsDirectory, { mode: 0o700 });
  return { appPath: fixture.appPath, envelope: fixture.envelope, ...fixture.trust, applicationsDirectory, ...overrides };
}

test('first installation is staged and verified before a single no-clobber move; development uses a distinct name', async t => {
  const fixture = await releaseFixture(t, { mode: 'development-unsigned' });
  const ops = testOperations();
  const options = await optionsFor(t, fixture, ops);
  const result = await installApplication(options);
  assert.match(result.destination, /RAPP Work Development\.app$/u);
  assert.deepEqual(ops.operations.map(operation => operation.operation), ['move']);
  assert.equal((await inventoryTree(result.destination)).digest, fixture.envelope.payload.app.digest);
  assert.equal(JSON.parse(await readFile(result.journalPath, 'utf8')).state, 'committed');
  await assert.rejects(lstat(path.join(options.applicationsDirectory, '.rapp-work-install.lock')), /ENOENT/u);
});

test('replacement uses atomic swap and retains a verified previous app for explicit rollback', async t => {
  const prior = await releaseFixture(t, { mode: 'development-unsigned' });
  const next = await releaseFixture(t, { mode: 'development-unsigned', version: '2.0.1', root: prior.root });
  const ops = testOperations();
  const options = await optionsFor(t, prior, ops);
  await installApplication(options);
  const updated = await installApplication({ ...options, appPath: next.appPath, envelope: next.envelope });
  assert.equal(updated.rollbackAvailable, true);
  assert.deepEqual(ops.operations.map(operation => operation.operation), ['move', 'swap']);
  assert.equal((await inventoryTree(updated.destination)).digest, next.envelope.payload.app.digest);
  await rollbackInstallation({ ...options, journalPath: updated.journalPath });
  assert.equal((await inventoryTree(updated.destination)).digest, prior.envelope.payload.app.digest);
  assert.equal(JSON.parse(await readFile(updated.journalPath, 'utf8')).state, 'rolled-back');
});

test('post-replacement verification failure restores the previous app without deleting either version', async t => {
  const prior = await releaseFixture(t, { mode: 'development-unsigned' });
  const next = await releaseFixture(t, { mode: 'development-unsigned', version: '2.0.1', root: prior.root });
  const apple = new TestAppleVerifier();
  const ops = testOperations(apple);
  const options = await optionsFor(t, prior, ops);
  const installed = await installApplication(options);
  const original = apple.application.bind(apple);
  let rejected = false;
  apple.application = async (appPath, parameters) => {
    if (appPath === installed.destination && parameters.version === '2.0.1' && !rejected) {
      rejected = true;
      throw new Error('Simulated post-install verification failure');
    }
    return original(appPath, parameters);
  };
  await assert.rejects(installApplication({ ...options, appPath: next.appPath, envelope: next.envelope }), /post-install verification failure/u);
  assert.equal((await inventoryTree(installed.destination)).digest, prior.envelope.payload.app.digest);
  assert.deepEqual(ops.operations.map(operation => operation.operation), ['move', 'swap', 'swap']);
});

test('a helper failure after the swap is reconciled by digests, not treated as an unperformed operation', async t => {
  const prior = await releaseFixture(t, { mode: 'development-unsigned' });
  const next = await releaseFixture(t, { mode: 'development-unsigned', version: '2.0.1', root: prior.root });
  const ops = testOperations();
  const options = await optionsFor(t, prior, ops);
  const installed = await installApplication(options);
  let failed = false;
  const operatorFactory = async () => async (...args) => {
    await ops.executeAtomic(...args);
    if (!failed) {
      failed = true;
      throw new Error('Durability acknowledgement lost after rename');
    }
  };
  await assert.rejects(installApplication({ ...options, operatorFactory, appPath: next.appPath, envelope: next.envelope }), /acknowledgement lost/u);
  assert.equal((await inventoryTree(installed.destination)).digest, prior.envelope.payload.app.digest);
});

test('restart recovery reconciles a prepared journal whose atomic swap already completed', async t => {
  const prior = await releaseFixture(t, { mode: 'development-unsigned' });
  const next = await releaseFixture(t, { mode: 'development-unsigned', version: '2.0.1', root: prior.root });
  const ops = testOperations();
  const options = await optionsFor(t, prior, ops);
  await installApplication(options);
  const installed = await installApplication({ ...options, appPath: next.appPath, envelope: next.envelope });
  const journal = JSON.parse(await readFile(installed.journalPath, 'utf8'));
  journal.state = 'prepared';
  await writeFile(installed.journalPath, JSON.stringify(journal));
  await recoverInstallation({ ...options, journalPath: installed.journalPath });
  assert.equal((await inventoryTree(installed.destination)).digest, prior.envelope.payload.app.digest);
});

test('unknown app changes, symlink destinations and active install locks are never overwritten', async t => {
  const fixture = await releaseFixture(t, { mode: 'development-unsigned' });
  const ops = testOperations();
  const options = await optionsFor(t, fixture, ops);
  const link = path.join(options.applicationsDirectory, 'RAPP Work Development.app');
  await symlink(fixture.appPath, link);
  await assert.rejects(installApplication(options), /symlink or non-directory/u);
  assert.equal(ops.operations.length, 0);
  assert((await lstat(link)).isSymbolicLink());
  await mkdir(path.join(options.applicationsDirectory, '.rapp-work-install.lock'));
  await assert.rejects(installApplication(options), /holds the install lock/u);
});

test('an altered or unsigned production app causes zero installation side effects', async t => {
  const fixture = await releaseFixture(t);
  const ops = testOperations();
  const options = await optionsFor(t, fixture, ops);
  const unsigned = structuredClone(fixture.envelope);
  unsigned.signature = null;
  let copies = 0;
  const copy = async () => { copies += 1; };
  await assert.rejects(installApplication({ ...options, copy, envelope: unsigned }), /Provenance signature/u);
  await writeFile(path.join(fixture.appPath, 'Contents/Resources/rapp-work-build.json'), '{}');
  await assert.rejects(installApplication({ ...options, copy }), /tree mismatch/u);
  assert.equal(copies, 0);
  assert.equal(ops.operations.length, 0);
});
