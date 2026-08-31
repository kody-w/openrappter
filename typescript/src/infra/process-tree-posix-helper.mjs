#!/usr/bin/env node

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';

const CONFIG_MAX_BYTES = 1_048_576;
const COMMAND_MAX_BYTES = 128;
const PROTOCOL_MAX_BUFFER_BYTES = 1_048_576;
const TARGET_LIMIT = 256;

const control = createReadStream('/dev/null', { fd: 3, autoClose: false });
const events = createWriteStream('/dev/null', { fd: 4, autoClose: false });
const decoder = new TextDecoder('utf-8', { fatal: true });

let buffered = Buffer.alloc(0);
const queued = [];
const waiters = [];
let protocolFailure;

function deliverLines() {
  while (true) {
    const newline = buffered.indexOf(0x0a);
    if (newline < 0) return;
    const line = buffered.subarray(0, newline);
    buffered = buffered.subarray(newline + 1);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  }
}

control.on('data', (chunk) => {
  if (protocolFailure) return;
  buffered = Buffer.concat([buffered, chunk]);
  const queuedBytes = queued.reduce((total, line) => total + line.length, 0);
  if (buffered.length + queuedBytes > PROTOCOL_MAX_BUFFER_BYTES) {
    protocolFailure = new Error('process-tree helper protocol exceeded its bound');
    for (const waiter of waiters.splice(0)) waiter.reject(protocolFailure);
    return;
  }
  deliverLines();
});
control.once('end', () => {
  protocolFailure ??= new Error('process-tree helper control stream closed');
  for (const waiter of waiters.splice(0)) waiter.reject(protocolFailure);
});
control.once('error', (error) => {
  protocolFailure = error;
  for (const waiter of waiters.splice(0)) waiter.reject(error);
});

function nextLine(maxBytes) {
  if (protocolFailure) return Promise.reject(protocolFailure);
  const queuedLine = queued.shift();
  if (queuedLine) {
    return queuedLine.length <= maxBytes
      ? Promise.resolve(queuedLine)
      : Promise.reject(new Error('process-tree helper line exceeded its bound'));
  }
  return new Promise((resolve, reject) => {
    waiters.push({
      resolve: (line) => {
        if (line.length > maxBytes) reject(new Error('process-tree helper line exceeded its bound'));
        else resolve(line);
      },
      reject,
    });
  });
}

function send(event) {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line, 'utf8') > 4_096) {
    throw new Error('process-tree helper event exceeded its bound');
  }
  events.write(line);
}

function boundedText(value, name, allowEmpty = false) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 32_767
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function readIncarnation(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    const started = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      },
    ).trim();
    return started ? `ps-c-utc:${started}` : null;
  } catch {
    return null;
  }
}

function validateConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('configuration must be an object');
  }
  if (value.version !== 1) throw new Error('unsupported helper protocol');
  const command = boundedText(value.command, 'command');
  if (!Array.isArray(value.args) || value.args.length > TARGET_LIMIT) {
    throw new Error('args is invalid');
  }
  const args = value.args.map((arg, index) => boundedText(arg, `args[${index}]`, true));
  const cwd = value.cwd === null ? undefined : boundedText(value.cwd, 'cwd');
  if (
    typeof value.env !== 'object'
    || value.env === null
    || Array.isArray(value.env)
    || Object.keys(value.env).length > TARGET_LIMIT
  ) {
    throw new Error('env is invalid');
  }
  const env = Object.create(null);
  for (const [key, entry] of Object.entries(value.env)) {
    boundedText(key, 'environment key');
    boundedText(entry, 'environment value', true);
    if (key.includes('=')) throw new Error('environment key is invalid');
    env[key] = entry;
  }
  const parentPid = Number(value.parent_pid);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) {
    throw new Error('parent_pid is invalid');
  }
  const parentIncarnation = value.parent_incarnation === null
    ? null
    : boundedText(value.parent_incarnation, 'parent_incarnation');
  return { command, args, cwd, env, parentPid, parentIncarnation };
}

function fatalKill() {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.exit(126);
  }
}

process.on('SIGTERM', () => {});
process.on('SIGCONT', () => {});
for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT']) {
  process.on(signal, fatalKill);
}
process.on('uncaughtException', fatalKill);
process.on('unhandledRejection', fatalKill);

try {
  const configBytes = await nextLine(CONFIG_MAX_BYTES);
  const config = validateConfig(JSON.parse(decoder.decode(configBytes)));
  const helperIncarnation = readIncarnation(process.pid);
  if (!helperIncarnation) throw new Error('helper incarnation unavailable');

  const initialParentPid = process.ppid;
  if (initialParentPid !== config.parentPid) throw new Error('parent PID changed before launch');
  if (
    config.parentIncarnation
    && readIncarnation(config.parentPid) !== config.parentIncarnation
  ) {
    throw new Error('parent incarnation changed before launch');
  }
  const parentMonitor = setInterval(() => {
    if (process.ppid !== initialParentPid) fatalKill();
  }, 250);
  parentMonitor.unref();

  const target = spawn(config.command, config.args, {
    shell: false,
    detached: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: config.env,
    ...(config.cwd ? { cwd: config.cwd } : {}),
  });
  target.stdin.on('error', () => {});
  target.stdout.pipe(process.stdout);
  target.stderr.pipe(process.stderr);
  process.stdin.pipe(target.stdin);

  let readySent = false;
  let exitReported = false;
  let targetExit;
  const reportTargetExit = () => {
    if (!readySent || !targetExit || exitReported) return;
    exitReported = true;
    send({
      protocol: 1,
      type: 'target_exit',
      code: targetExit.code,
      signal: targetExit.signal,
    });
  };
  target.once('exit', (code, signal) => {
    process.stdin.unpipe(target.stdin);
    targetExit = { code, signal };
    reportTargetExit();
  });
  target.once('close', () => {
    let pendingOutputs = 2;
    const outputClosed = () => {
      pendingOutputs -= 1;
      if (pendingOutputs === 0) reportTargetExit();
    };
    process.stdout.end(outputClosed);
    process.stderr.end(outputClosed);
  });

  await new Promise((resolve, reject) => {
    target.once('spawn', resolve);
    target.once('error', reject);
  });
  let targetIncarnation = readIncarnation(target.pid);
  if (!targetIncarnation) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    targetIncarnation = readIncarnation(target.pid);
  }
  if (!targetIncarnation && targetExit) {
    targetIncarnation = `completed:${target.pid}:${randomUUID()}`;
  }
  if (!targetIncarnation) throw new Error('target incarnation unavailable');

  send({
    protocol: 1,
    type: 'ready',
    helper_pid: process.pid,
    helper_incarnation: helperIncarnation,
    target_pid: target.pid,
    target_incarnation: targetIncarnation,
  });
  readySent = true;
  reportTargetExit();

  while (true) {
    const command = decoder.decode(await nextLine(COMMAND_MAX_BYTES));
    if (command === 'terminate') {
      process.kill(-process.pid, 'SIGTERM');
      try {
        process.kill(-process.pid, 'SIGCONT');
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 'EPERM') throw error;
      }
      continue;
    }
    if (command === 'kill') {
      fatalKill();
      await new Promise(() => {});
    }
    throw new Error('unknown process-tree helper command');
  }
} catch {
  fatalKill();
}
