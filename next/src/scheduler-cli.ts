#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalJson } from './canonical.js';
import { Refusal, publicError, requireThat } from './errors.js';
import { FIXTURE_WARNING, fixtureSigners } from './fixtures.js';
import { RecurrenceScheduler } from './recurrence-scheduler.js';
import { HeadlessRuntime } from './runtime.js';

function integer(value: string | undefined, option: string): number {
  const parsed = Number(value);
  requireThat(value !== undefined && Number.isSafeInteger(parsed), 'cli', `${option} requires an integer.`);
  return parsed;
}

async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.length === 0) {
    console.log('RAPP Work unattended recurrence scheduler\n'
      + 'Usage: node next/dist/scheduler-cli.js --store <dedicated-directory> --root <full-rappid> [--root <full-rappid> ...] [--fixture] [--once] [--poll-ms 1000] [--lease-ms 30000]\n'
      + 'The explicit root allowlist is owner launch authorization. The process runs canonical-recap only; it has no provider, channel, external-effect or approval authority.');
    return;
  }
  let directory: string | undefined;
  let fixture = false;
  let once = false;
  let pollMs: number | undefined;
  let leaseMs: number | undefined;
  const roots: string[] = [];
  while (args.length) {
    const option = args.shift()!;
    if (option === '--store') directory = args.shift();
    else if (option === '--root') roots.push(args.shift() ?? '');
    else if (option === '--fixture') fixture = true;
    else if (option === '--once') once = true;
    else if (option === '--poll-ms') pollMs = integer(args.shift(), option);
    else if (option === '--lease-ms') leaseMs = integer(args.shift(), option);
    else throw new Refusal('cli', `Unknown scheduler option: ${option}`);
  }
  requireThat(directory && roots.length > 0, 'cli', 'An explicit store and at least one exact root are required.');
  const synthetic = fixture ? fixtureSigners() : null;
  const runtime = await HeadlessRuntime.open({
    directory,
    ...(synthetic ? { ...synthetic, fixture: true } : {}),
  });
  if (fixture) console.error(FIXTURE_WARNING);
  const scheduler = new RecurrenceScheduler(runtime.recurring, {
    roots,
    ...(pollMs === undefined ? {} : { pollMs }),
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
  if (once) {
    const report = await scheduler.runOnce();
    console.log(canonicalJson(report));
    if (report.roots.some(root => root.status === 'fenced')) process.exitCode = 2;
    return;
  }
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  await scheduler.run(abort.signal, report => {
    process.stdout.write(`${canonicalJson(report)}\n`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(canonicalJson(publicError(error)));
    process.exitCode = 1;
  });
}
