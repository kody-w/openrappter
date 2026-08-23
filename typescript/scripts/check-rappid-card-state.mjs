import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { SQLiteCardState } from '../dist/rappid-card/sqlite-state-store.js';

const argument = process.argv.indexOf('--state-dir');
if (argument < 0 || !process.argv[argument + 1]) {
  throw new Error('--state-dir is required');
}
const stateDir = resolve(process.argv[argument + 1]);
await mkdir(stateDir, { recursive: true });
const moduleUrl = pathToFileURL(
  resolve('dist/rappid-card/sqlite-state-store.js'),
).href;
const now = '2026-08-21T12:30:00.000Z';
const authority =
  `rappid:@example/card-authority:${'a'.repeat(64)}`;

async function clean(path) {
  await Promise.all(
    ['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })),
  );
}

async function restartCheck() {
  const path = resolve(stateDir, 'restart.sqlite');
  await clean(path);
  const nonce = 'restart-crash-nonce-01';
  const first = await SQLiteCardState.open(path);
  const claimed = first.claimNonce(nonce, 'connection-a', now);
  const restarted = await SQLiteCardState.open(path);
  const resumed = restarted.claimNonce(nonce, 'connection-a', now);
  const contender = (await SQLiteCardState.open(path))
    .claimNonce(nonce, 'connection-b', now);
  const awake = restarted.markAwake(nonce, 'connection-a', now);
  const replay = (await SQLiteCardState.open(path))
    .claimNonce(nonce, 'connection-c', now);
  const ok =
    claimed[0]
    && resumed[0]
    && !contender[0]
    && awake[0]
    && !replay[0]
    && (await SQLiteCardState.open(path)).nonceState(nonce)?.state === 'awake';
  await clean(path);
  return ok;
}

async function threadCheck() {
  const path = resolve(stateDir, 'threads.sqlite');
  await clean(path);
  await SQLiteCardState.open(path);
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(async ({ SQLiteCardState }) => {
      const state = await SQLiteCardState.open(workerData.path);
      parentPort.postMessage(state.claimNonce(
        workerData.nonce, workerData.connection, workerData.now
      ));
    }).catch(error => { throw error; });
  `;
  const values = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      new Promise((accept, reject) => {
        const worker = new Worker(source, {
          eval: true,
          workerData: {
            moduleUrl,
            path,
            nonce: 'thread-contention-nonce',
            connection: `thread-${index}`,
            now,
          },
        });
        worker.once('message', accept);
        worker.once('error', reject);
      })),
  );
  await clean(path);
  return values.filter(([accepted]) => accepted).length === 1;
}

async function processCheck() {
  const path = resolve(stateDir, 'processes.sqlite');
  await clean(path);
  await SQLiteCardState.open(path);
  const source = `
    const [moduleUrl, path, connection, now] = process.argv.slice(1);
    import(moduleUrl).then(async ({ SQLiteCardState }) => {
      const state = await SQLiteCardState.open(path);
      process.stdout.write(JSON.stringify(state.claimNonce(
        'process-contention-nonce', connection, now
      )));
    });
  `;
  const values = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      new Promise((accept, reject) => {
        const child = spawn(
          process.execPath,
          ['-e', source, moduleUrl, path, `process-${index}`, now],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (value) => { stdout += value; });
        child.stderr.on('data', (value) => { stderr += value; });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
          else accept(JSON.parse(stdout));
        });
      })),
  );
  await clean(path);
  return values.filter(([accepted]) => accepted).length === 1;
}

async function sequenceCheck() {
  const path = resolve(stateDir, 'sequences.sqlite');
  await clean(path);
  const state = await SQLiteCardState.open(path);
  const initial = state.acceptSequence('card-revocation', authority, 10, 'a'.repeat(64));
  const rollback = state.acceptSequence('card-revocation', authority, 9, 'b'.repeat(64));
  const replay = state.acceptSequence('card-revocation', authority, 10, 'a'.repeat(64));
  const fork = state.acceptSequence('card-revocation', authority, 10, 'c'.repeat(64));
  const advance = state.acceptSequence('card-revocation', authority, 11, 'd'.repeat(64));
  await clean(path);
  return initial[0] && !rollback[0] && replay[0] && !fork[0] && advance[0];
}

const checks = {
  'restart/crash-window': await restartCheck(),
  'thread contention': await threadCheck(),
  'independent-process contention': await processCheck(),
  'sequence rollback/fork': await sequenceCheck(),
};
for (const [name, passed] of Object.entries(checks)) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
}
await rm(stateDir, { recursive: true, force: true });
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
