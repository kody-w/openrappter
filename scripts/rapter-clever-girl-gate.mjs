#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const ENGINE = path.join(SCRIPT_DIR, 'rapter-clever-girl.mjs');
const TEST = path.join(SCRIPT_DIR, 'rapter-clever-girl.test.mjs');
const CONTRACT = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-observe-v1.json',
);
const DOGFOOD_REPORT = path.join(
  REPO_ROOT,
  'fable5',
  'reports',
  'rapter-clever-girl-dogfood.json',
);
const DOGFOOD_INPUT = path.join(
  REPO_ROOT,
  'fable5',
  'reports',
  'rapter-clever-girl-dogfood-input.jsonl',
);
const BENCHMARK_REPORT = path.join(
  REPO_ROOT,
  'fable5',
  'reports',
  'rapter-clever-girl-benchmark.json',
);
const BENCHMARK = path.join(SCRIPT_DIR, 'rapter-clever-girl-benchmark.mjs');
const FIXTURES = path.join(SCRIPT_DIR, 'fixtures', 'rapter-clever-girl');
const requireFromTypescript = createRequire(
  new URL('../typescript/package.json', import.meta.url),
);
const Ajv2020 = requireFromTypescript('ajv/dist/2020').default;
const addFormats = requireFromTypescript('ajv-formats').default;

const checks = [];

function check(name, operation) {
  try {
    operation();
    checks.push({ name, pass: true });
    process.stdout.write(` PASS  ${name}\n`);
  } catch (error) {
    checks.push({ name, pass: false, detail: error.message });
    process.stderr.write(`*FAIL  ${name}: ${error.message}\n`);
  }
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function requireSuccess(result, label) {
  assert.equal(result.error, undefined, `${label} did not start: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${label} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function fixture(name) {
  return path.join(FIXTURES, name);
}

function observeArgs(engine = ENGINE) {
  const inputs = [
    'normalized.jsonl',
    'copilot-export.jsonl',
    'claude.jsonl',
    'codex-rollout.jsonl',
    'openrappter-flight.json',
    'controls-only.jsonl',
  ];
  return [
    engine,
    'observe',
    ...inputs.flatMap((name) => ['--input', fixture(name)]),
    '--source',
    'auto',
    '--skills-root',
    path.join(FIXTURES, 'skills'),
  ];
}

function makeMutationTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rapter-clever-girl-gate-'));
  cpSync(SCRIPT_DIR, path.join(root, 'scripts'), { recursive: true });
  cpSync(path.dirname(CONTRACT), path.join(root, 'contracts'), { recursive: true });
  return root;
}

function mutateAndRequireRed({ name, find, replace }) {
  const root = makeMutationTree();
  try {
    const engine = path.join(root, 'scripts', 'rapter-clever-girl.mjs');
    const test = path.join(root, 'scripts', 'rapter-clever-girl.test.mjs');
    const source = readFileSync(engine, 'utf8');
    const occurrences = source.split(find).length - 1;
    assert.equal(occurrences, 1, `${name} mutation matched ${occurrences} locations`);
    writeFileSync(engine, source.replace(find, replace), { mode: 0o600 });
    const result = runNode(['--test', test], { cwd: root });
    assert.equal(result.error, undefined, `${name} mutation test did not start`);
    assert.notEqual(
      result.status,
      0,
      `${name} mutation stayed green; the suite did not defend the invariant`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

check('contract is valid and pins the observe invariants', () => {
  const contract = JSON.parse(readFileSync(CONTRACT, 'utf8'));
  assert.equal(contract.properties.schemaVersion.const, 'rapter-clever-girl.observe.v1');
  assert.equal(contract.properties.mode.const, 'observe');
  assert.equal(contract.properties.candidates.maxItems, 5);
  assert.equal(contract['x-openrappter-contract'].minimumSessions, 3);
  assert.equal(contract['x-openrappter-contract'].minimumActiveDays, 2);
  assert.equal(contract['x-openrappter-contract'].activeGapCapSeconds, 300);
  assert.ok(
    contract['x-openrappter-contract'].observeInvariants.includes('no network calls'),
  );
  assert.ok(
    contract['x-openrappter-contract'].observeInvariants.includes(
      'promotion is outside this contract',
    ),
  );

  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
  });
  addFormats(ajv);
  ajv.addKeyword({
    keyword: 'x-openrappter-contract',
    schemaType: 'object',
    valid: true,
  });
  const validate = ajv.compile(contract);
  const reports = [
    runNode(observeArgs()),
    runNode([
      ENGINE,
      'observe',
      '--input',
      fixture('partial-normalized.jsonl'),
      '--source',
      'normalized',
    ]),
    runNode([
      ENGINE,
      'observe',
      '--input',
      fixture('empty.jsonl'),
      '--source',
      'normalized',
    ]),
    { stdout: readFileSync(DOGFOOD_REPORT, 'utf8') },
  ].map((result) => JSON.parse(result.stdout));
  assert.deepEqual(reports.map(({ status }) => status), ['ok', 'partial', 'failed', 'ok']);
  for (const report of reports) {
    assert.equal(
      validate(report),
      true,
      `schema validation failed: ${JSON.stringify(validate.errors)}`,
    );
  }
  const invalid = { ...reports[0], unexpected: true };
  assert.equal(validate(invalid), false, 'validator accepted an undeclared report field');
});

check('observer source has no network, subprocess, or implicit-history capability', () => {
  const source = readFileSync(ENGINE, 'utf8');
  const forbidden = [
    /node:(?:child_process|http|https|net|tls|dns|dgram)/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bXMLHttpRequest\b/,
    /\bhomedir\s*\(/,
    /process\.env\.(?:HOME|USERPROFILE|XDG_[A-Z_]+)/,
    /~\/\.(?:claude|copilot|codex|openrappter)/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});

check('pull-request CI and release preflight fail hard on this gate', () => {
  for (const relativePath of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
  ]) {
    const workflow = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    assert.match(workflow, /run: node scripts\/rapter-clever-girl-gate\.mjs/);
    assert.doesNotMatch(
      workflow,
      /continue-on-error:\s*true[\s\S]{0,240}rapter-clever-girl-gate/,
    );
  }
});

check('full adversarial node:test suite passes', () => {
  const result = runNode(['--test', TEST]);
  requireSuccess(result, 'adversarial suite');
  assert.match(result.stdout, /(?:#|ℹ)\s+pass 29\b/);
  assert.match(result.stdout, /(?:#|ℹ)\s+fail 0\b/);
});

check('fresh fixture replay produces the intended inert decisions', () => {
  const result = runNode(observeArgs());
  requireSuccess(result, 'fresh fixture replay');
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'ok');
  assert.equal(report.excluded.controlMessages, 7);
  assert.ok(report.candidates.length <= 5);

  const repair = report.candidates.find(({ patternType }) => patternType === 'repair-loop');
  assert.equal(repair?.classification, 'root-cause-fix');
  assert.equal(repair?.confidence, 'high');
  assert.ok(repair.sessions >= 4);
  assert.ok(repair.activeDays >= 3);

  const review = report.candidates.find(({ patternType }) => patternType === 'review-workflow');
  assert.equal(review?.existingCapability?.name, 'release-reviewer');
  assert.ok(['reuse-existing', 'extend-existing'].includes(review?.classification));
  assert.doesNotMatch(result.stdout, /\btime[- ]saved\b/i);
  assert.doesNotMatch(result.stdout, /https?:\/\//i);
});

check('committed redacted dogfood and benchmark evidence regenerate', () => {
  const dogfood = JSON.parse(readFileSync(DOGFOOD_REPORT, 'utf8'));
  const inputBytes = readFileSync(DOGFOOD_INPUT);
  assert.equal(
    dogfood.sources[0].sourceDigest,
    `sha256:${createHash('sha256').update(inputBytes).digest('hex')}`,
  );

  const observe = runNode([
    ENGINE,
    'observe',
    '--input',
    DOGFOOD_INPUT,
    '--source',
    'copilot',
    '--skills-root',
    path.join(REPO_ROOT, '.claude', 'skills'),
  ]);
  requireSuccess(observe, 'redacted dogfood replay');
  assert.deepEqual(JSON.parse(observe.stdout), dogfood);

  const benchmark = JSON.parse(readFileSync(BENCHMARK_REPORT, 'utf8'));
  const reportSha256 = createHash('sha256').update(observe.stdout).digest('hex');
  assert.equal(benchmark.reportSha256, reportSha256);
  assert.equal(benchmark.byteIdentical, true);

  const benchmarkSmoke = runNode([
    BENCHMARK,
    '--runs',
    '2',
    '--input',
    DOGFOOD_INPUT,
    '--source',
    'copilot',
    '--skills-root',
    path.join(REPO_ROOT, '.claude', 'skills'),
  ]);
  requireSuccess(benchmarkSmoke, 'benchmark smoke');
  assert.equal(JSON.parse(benchmarkSmoke.stdout).reportSha256, reportSha256);
});

check('control-message detector mutation is caught', () => {
  mutateAndRequireRed({
    name: 'control-message',
    find: '/^(?:continue|yes|y|ok|okay|sure|go ahead|proceed|done|thanks|thank you|no|nope)',
    replace: '/^(?:continuation|yes|y|ok|okay|sure|go ahead|proceed|done|thanks|thank you|no|nope)',
  });
});

check('private-output permission mutation is caught', () => {
  mutateAndRequireRed({
    name: 'private-output',
    find: 'await chmod(output, 0o600);',
    replace: 'await chmod(output, 0o644);',
  });
});

check('source-symlink refusal mutation is caught', () => {
  mutateAndRequireRed({
    name: 'source-symlink',
    find: 'if (before.isSymbolicLink()) throw new SafeReadError(symlinkCode);',
    replace: 'if (false && before.isSymbolicLink()) throw new SafeReadError(symlinkCode);',
  });
});

check('opened-file identity mutation is caught', () => {
  mutateAndRequireRed({
    name: 'opened-file-identity',
    find:
      "String(before.dev) !== String(after.dev) ||\n      String(before.ino) !== String(after.ino)",
    replace: 'false',
  });
});

check('candidate-cap mutation is caught', () => {
  mutateAndRequireRed({
    name: 'candidate-cap',
    find: 'candidates: candidates.slice(0, MAX_CANDIDATES),',
    replace: 'candidates,',
  });
});

check('active-gap-cap mutation is caught', () => {
  mutateAndRequireRed({
    name: 'active-gap-cap',
    find: 'const ACTIVE_GAP_CAP_SECONDS = 300;',
    replace: 'const ACTIVE_GAP_CAP_SECONDS = 600;',
  });
});

const failed = checks.filter(({ pass }) => !pass);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exitCode = failed.length === 0 ? 0 : 1;
