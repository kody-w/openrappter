#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(SCRIPT_DIR, 'rapter-clever-girl.mjs');

function parseArguments(argv) {
  let runs = 20;
  const observeArguments = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--runs' || argument.startsWith('--runs=')) {
      const value = argument === '--runs' ? argv[++index] : argument.slice('--runs='.length);
      if (!/^[0-9]+$/.test(value ?? '')) {
        throw new Error('--runs requires an integer');
      }
      runs = Number(value);
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      throw new Error('benchmark mode does not permit --output');
    }
    observeArguments.push(argument);
  }
  if (!Number.isSafeInteger(runs) || runs < 2 || runs > 100) {
    throw new Error('--runs must be between 2 and 100');
  }
  return { runs, observeArguments };
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function main(argv = process.argv.slice(2)) {
  const { runs, observeArguments } = parseArguments(argv);
  const elapsed = [];
  let baseline = null;
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    const result = spawnSync(
      process.execPath,
      [ENGINE, 'observe', ...observeArguments],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    elapsed.push(performance.now() - started);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`observe run ${index + 1} exited ${result.status}: ${result.stderr.trim()}`);
    }
    if (baseline === null) baseline = result.stdout;
    else if (result.stdout !== baseline) throw new Error('observe output was not byte-identical');
  }

  elapsed.sort((left, right) => left - right);
  const report = {
    schemaVersion: 'rapter-clever-girl.benchmark.v1',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runs,
    p50Ms: Number(percentile(elapsed, 0.5).toFixed(1)),
    p95Ms: Number(percentile(elapsed, 0.95).toFixed(1)),
    maxMs: Number(elapsed.at(-1).toFixed(1)),
    byteIdentical: true,
    reportSha256: createHash('sha256').update(baseline).digest('hex'),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Benchmark failed: ${error.message}\n`);
  process.exitCode = 1;
}
