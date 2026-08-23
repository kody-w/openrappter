#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const ENGINE = path.join(SCRIPT_DIR, 'rapter-clever-girl.mjs');
const CONTEXT_ENGINE = path.join(SCRIPT_DIR, 'rapter-clever-girl-context.mjs');
const TEST = path.join(SCRIPT_DIR, 'rapter-clever-girl.test.mjs');
const CONTEXT_TEST = path.join(SCRIPT_DIR, 'rapter-clever-girl-context.test.mjs');
const V3_TEST = path.join(SCRIPT_DIR, 'rapter-clever-girl-v3.test.mjs');
const READER = path.join(SCRIPT_DIR, 'rapter-clever-girl-reader.mjs');
const SCHEMA_VALIDATOR = path.join(
  SCRIPT_DIR,
  'rapter-clever-girl-schema-validator.mjs',
);
const CONTRACT = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-observe-v2.json',
);
const V3_CONTRACT = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-observe-v3.json',
);
const CAPABILITY_CONTRACT = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-capability-catalog-v2.json',
);
const SIDECAR_CONTRACT = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-repair-assignments-v1.json',
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
const TEST_WORK_ROOT = path.join(REPO_ROOT, '.test-work');
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
    '--report-version',
    '2',
  ];
}

function makeMutationTree() {
  mkdirSync(TEST_WORK_ROOT, { recursive: true });
  const root = mkdtempSync(
    path.join(TEST_WORK_ROOT, 'rapter-clever-girl-gate-'),
  );
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
    assert.ok(occurrences >= 1, `${name} mutation matched no locations`);
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
  assert.equal(contract.properties.schemaVersion.const, 'rapter-clever-girl.observe.v2');
  assert.equal(contract.properties.mode.const, 'observe');
  assert.equal(contract.properties.candidates.maxItems, 5);
  assert.equal(contract['x-openrappter-contract'].minimumSessions, 3);
  assert.equal(contract['x-openrappter-contract'].minimumActiveDays, 2);
  assert.equal(contract['x-openrappter-contract'].activeGapCapSeconds, 300);
  assert.equal(contract['x-openrappter-contract'].maximumInputBytes, 67_108_864);
  assert.equal(contract['x-openrappter-contract'].maximumSkillDepth, 12);
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
      '--report-version',
      '2',
    ]),
    runNode([
      ENGINE,
      'observe',
      '--input',
      fixture('empty.jsonl'),
      '--source',
      'normalized',
      '--report-version',
      '2',
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

  const v3Contract = JSON.parse(readFileSync(V3_CONTRACT, 'utf8'));
  const capabilityContract = JSON.parse(readFileSync(CAPABILITY_CONTRACT, 'utf8'));
  const sidecarContract = JSON.parse(readFileSync(SIDECAR_CONTRACT, 'utf8'));
  ajv.addSchema(v3Contract);
  const validateV3 = ajv.getSchema(v3Contract.$id);
  const validateCapability = ajv.compile(capabilityContract);
  const validateSidecar = ajv.compile(sidecarContract);
  mkdirSync(TEST_WORK_ROOT, { recursive: true });
  const v3Output = path.join(TEST_WORK_ROOT, 'gate-v3-sidecar.json');
  rmSync(v3Output, { force: true });
  const v3Result = runNode([
    ENGINE,
    'observe',
    '--input',
    fixture('normalized.jsonl'),
    '--source',
    'normalized',
    '--capability-catalog',
    fixture('capability-contract-catalog.json'),
    '--report-version',
    '3',
    '--facet-sidecar-output',
    v3Output,
  ]);
  requireSuccess(v3Result, 'v3 contract replay');
  assert.equal(
    validateV3(JSON.parse(v3Result.stdout)),
    true,
    `v3 schema validation failed: ${JSON.stringify(validateV3.errors)}`,
  );
  assert.equal(
    validateSidecar(JSON.parse(readFileSync(v3Output, 'utf8'))),
    true,
    `sidecar schema validation failed: ${JSON.stringify(validateSidecar.errors)}`,
  );
  assert.equal(
    validateCapability(
      JSON.parse(readFileSync(fixture('capability-contract-catalog.json'), 'utf8')),
    ),
    true,
    `capability schema validation failed: ${JSON.stringify(validateCapability.errors)}`,
  );
  rmSync(v3Output, { force: true });
});

check('observer source has no network, subprocess, or implicit-history capability', () => {
  const source = [
    readFileSync(ENGINE, 'utf8'),
    readFileSync(CONTEXT_ENGINE, 'utf8'),
    readFileSync(READER, 'utf8'),
    readFileSync(SCHEMA_VALIDATOR, 'utf8'),
  ].join('\n');
  const forbidden = [
    /node:(?:child_process|http|https|net|tls|dns|dgram)/,
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bXMLHttpRequest\b/,
    /\b(?:openai|anthropic|bedrock|vertexai)\b/i,
    /\bhomedir\s*\(/,
    /process\.env\.(?:HOME|USERPROFILE|XDG_[A-Z_]+)/,
    /~\/\.(?:claude|copilot|codex|openrappter)/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(source, pattern);
  }
});

check('schema validator dependencies use public registry tarballs and SHA-512', () => {
  const lock = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'typescript', 'package-lock.json'), 'utf8'),
  );
  for (const key of [
    'node_modules/@eslint/eslintrc/node_modules/ajv',
    'node_modules/@eslint/eslintrc/node_modules/json-schema-traverse',
    'node_modules/ajv',
    'node_modules/ajv-formats',
    'node_modules/eslint/node_modules/ajv',
    'node_modules/eslint/node_modules/json-schema-traverse',
    'node_modules/fast-json-stable-stringify',
    'node_modules/fast-uri',
    'node_modules/json-schema-traverse',
    'node_modules/uri-js',
  ]) {
    const entry = lock.packages[key];
    assert.ok(entry, `lockfile is missing ${key}`);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
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

check('bounded estate and repository-evidence suite passes', () => {
  const result = runNode(['--test', CONTEXT_TEST]);
  requireSuccess(result, 'context adversarial suite');
  assert.match(result.stdout, /(?:#|ℹ)\s+pass 13\b/);
  assert.match(result.stdout, /(?:#|ℹ)\s+fail 0\b/);
});

check('v3 split detector and compatibility suite passes', () => {
  const result = runNode(['--test', V3_TEST]);
  requireSuccess(result, 'v3 adversarial suite');
  assert.match(result.stdout, /(?:#|ℹ)\s+pass 17\b/);
  assert.match(result.stdout, /(?:#|ℹ)\s+fail 0\b/);
});

check('unflagged compatibility stays byte-identical v2 and auto is explicit', () => {
  const base = [
    ENGINE,
    'observe',
    '--input',
    fixture('normalized.jsonl'),
    '--source',
    'normalized',
  ];
  const unflagged = runNode(base);
  const explicitV2 = runNode([...base, '--report-version', '2']);
  requireSuccess(unflagged, 'unflagged v2 replay');
  requireSuccess(explicitV2, 'explicit v2 replay');
  assert.equal(unflagged.stdout, explicitV2.stdout);
  assert.equal(
    JSON.parse(unflagged.stdout).schemaVersion,
    'rapter-clever-girl.observe.v2',
  );

  const automatic = runNode([
    ...base,
    '--capability-catalog',
    fixture('capability-contract-catalog.json'),
    '--report-version',
    'auto',
  ]);
  requireSuccess(automatic, 'explicit auto replay');
  assert.equal(
    JSON.parse(automatic.stdout).schemaVersion,
    'rapter-clever-girl.observe.v3',
  );
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
    '--report-version',
    '2',
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
    '--report-version',
    '2',
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
