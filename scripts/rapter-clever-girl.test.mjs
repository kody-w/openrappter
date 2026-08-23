import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const ENGINE_PATH = path.join(SCRIPT_DIR, 'rapter-clever-girl.mjs');
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  'contracts',
  'rapter-clever-girl-observe-v2.json',
);
const FIXTURES = path.join(
  SCRIPT_DIR,
  'fixtures',
  'rapter-clever-girl',
);
const SKILLS_ROOT = path.join(FIXTURES, 'skills');
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const TEMPORARY_DIRECTORIES = [];

const PROVIDERS = [
  ['normalized', 'normalized.jsonl'],
  ['copilot', 'copilot-export.jsonl'],
  ['claude', 'claude.jsonl'],
  ['codex', 'codex-rollout.jsonl'],
  ['openrappter', 'openrappter-flight.json'],
];
const FULL_INPUTS = [
  ...PROVIDERS.map(([, name]) => fixture(name)),
  fixture('controls-only.jsonl'),
];

const REQUIRED_EXPORTS = [
  'parseArgs',
  'parseHistoryBytes',
  'normalizeRecord',
  'openRegularFileNoFollow',
  'readHandleBounded',
  'loadSkillCatalog',
  'analyzeHistory',
  'stableStringify',
  'runObserveCli',
  'validateOutputScope',
  'main',
];

const engine = await import(pathToFileURL(ENGINE_PATH).href);

afterEach(() => {
  for (const directory of TEMPORARY_DIRECTORIES.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(name) {
  return path.join(FIXTURES, name);
}

function temporaryDirectory(label = 'case') {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), `rapter-clever-girl-${label}-`),
  );
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
}

function cliArguments({
  inputs = [],
  source = 'auto',
  skillsRoot,
  skillsRoots,
  extra = [],
}) {
  const args = [ENGINE_PATH, 'observe'];
  for (const input of inputs) args.push('--input', input);
  args.push('--source', source);
  for (const root of skillsRoots ?? (skillsRoot ? [skillsRoot] : [])) {
    args.push('--skills-root', root);
  }
  args.push(...extra);
  return args;
}

function isolatedEnvironment(directory) {
  return {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
    XDG_DATA_HOME: path.join(directory, 'xdg-data'),
    XDG_CACHE_HOME: path.join(directory, 'xdg-cache'),
    OPENRAPPTER_HOME: path.join(directory, 'openrappter-home'),
  };
}

function runCli(options = {}) {
  const cwd = options.cwd ?? temporaryDirectory('cwd');
  return spawnSync(
    process.execPath,
    cliArguments(options),
    {
      cwd,
      encoding: 'utf8',
      env: isolatedEnvironment(cwd),
      ...(options.env ? { env: { ...isolatedEnvironment(cwd), ...options.env } } : {}),
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function runCliAsync(options = {}) {
  const cwd = options.cwd ?? temporaryDirectory('async-cwd');
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, cliArguments(options), {
      cwd,
      env: { ...isolatedEnvironment(cwd), ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

function runCliWithUmask(umask, options = {}) {
  const cwd = options.cwd ?? temporaryDirectory('umask-cwd');
  const runner = [
    "import { spawnSync } from 'node:child_process';",
    'process.umask(Number(process.argv[1]));',
    'const child = spawnSync(process.execPath, process.argv.slice(2), {',
    "  stdio: 'inherit',",
    '  env: process.env,',
    '});',
    'process.exit(child.status ?? 70);',
  ].join('\n');

  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      runner,
      String(umask),
      ...cliArguments(options),
    ],
    {
      cwd,
      encoding: 'utf8',
      env: isolatedEnvironment(cwd),
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function parseStdoutReport(result, context = 'observe command') {
  assert.equal(
    result.error,
    undefined,
    `${context} failed to start: ${result.error?.message ?? ''}`,
  );
  assert.notEqual(
    result.stdout.trim(),
    '',
    `${context} produced no report\nstderr:\n${result.stderr}`,
  );
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(
      `${context} did not emit JSON: ${error.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function successfulReport(options = {}) {
  const result = runCli(options);
  assert.equal(
    result.status,
    0,
    `observe command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return {
    bytes: result.stdout,
    report: parseStdoutReport(result),
    stderr: result.stderr,
  };
}

function fullReport(options = {}) {
  return successfulReport({
    inputs: FULL_INPUTS,
    source: 'auto',
    skillsRoot: SKILLS_ROOT,
    ...options,
  });
}

function exactKeys(value, expected, label) {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    `${label} has missing or additional properties`,
  );
}

function validDateTime(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && /T/.test(value);
}

function assertReportContract(report) {
  exactKeys(report, [
    'schemaVersion',
    'mode',
    'status',
    'scope',
    'sources',
    'summary',
    'candidates',
    'excluded',
    'context',
    'replay',
    'diagnostics',
  ], 'report');
  assert.equal(report.schemaVersion, 'rapter-clever-girl.observe.v2');
  assert.equal(report.mode, 'observe');
  assert.ok(['ok', 'partial', 'failed'].includes(report.status));

  exactKeys(report.scope, [
    'windowStart',
    'windowEnd',
    'minimumSessions',
    'minimumActiveDays',
    'skillsRootsCount',
    'repositoryActivityInputsCount',
    'capabilityCatalogInputsCount',
    'estateManifestProvided',
  ], 'scope');
  assert.ok(report.scope.windowStart === null || validDateTime(report.scope.windowStart));
  assert.ok(report.scope.windowEnd === null || validDateTime(report.scope.windowEnd));
  assert.ok(Number.isInteger(report.scope.minimumSessions));
  assert.ok(report.scope.minimumSessions >= 2);
  assert.ok(Number.isInteger(report.scope.minimumActiveDays));
  assert.ok(report.scope.minimumActiveDays >= 1);
  assert.ok(Number.isInteger(report.scope.skillsRootsCount));
  assert.ok(report.scope.skillsRootsCount >= 0);
  assert.ok(Number.isInteger(report.scope.repositoryActivityInputsCount));
  assert.ok(report.scope.repositoryActivityInputsCount >= 0);
  assert.ok(Number.isInteger(report.scope.capabilityCatalogInputsCount));
  assert.ok(report.scope.capabilityCatalogInputsCount >= 0);
  assert.equal(typeof report.scope.estateManifestProvided, 'boolean');

  assert.ok(Array.isArray(report.sources) && report.sources.length >= 1);
  for (const [index, source] of report.sources.entries()) {
    exactKeys(source, [
      'sourceId',
      'sourceType',
      'sourceDigest',
      'status',
      'acceptedRecords',
      'skippedRecords',
    ], `sources[${index}]`);
    assert.match(source.sourceId, /^source-[a-f0-9]{12}$/);
    assert.ok([
      'auto',
      'claude',
      'codex',
      'copilot',
      'openrappter',
      'normalized',
    ].includes(source.sourceType));
    assert.match(source.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(['ok', 'partial', 'failed'].includes(source.status));
    assert.ok(Number.isInteger(source.acceptedRecords) && source.acceptedRecords >= 0);
    assert.ok(Number.isInteger(source.skippedRecords) && source.skippedRecords >= 0);
  }

  exactKeys(report.summary, [
    'sessions',
    'activeDays',
    'acceptedRecords',
    'skippedRecords',
    'candidateCount',
    'highConfidenceCandidateCount',
    'selectedCandidateId',
    'repositoryActivityRecords',
    'capabilitiesInspected',
  ], 'summary');
  for (const key of [
    'sessions',
    'activeDays',
    'acceptedRecords',
    'skippedRecords',
    'candidateCount',
    'highConfidenceCandidateCount',
    'repositoryActivityRecords',
    'capabilitiesInspected',
  ]) {
    const value = report.summary[key];
    assert.ok(Number.isInteger(value) && value >= 0, `summary.${key} is invalid`);
  }
  assert.ok(
    report.summary.selectedCandidateId === null ||
      /^candidate-[a-f0-9]{16}$/.test(report.summary.selectedCandidateId),
  );
  assert.equal(report.summary.candidateCount, report.candidates.length);
  assert.equal(
    report.summary.highConfidenceCandidateCount,
    report.candidates.filter(({ confidence }) => confidence === 'high').length,
  );
  assert.equal(
    report.summary.acceptedRecords,
    report.sources.reduce((sum, source) => sum + source.acceptedRecords, 0),
  );
  assert.equal(
    report.summary.skippedRecords,
    report.sources.reduce((sum, source) => sum + source.skippedRecords, 0),
  );

  assert.ok(Array.isArray(report.candidates));
  assert.ok(report.candidates.length <= 5);
  for (const [index, candidate] of report.candidates.entries()) {
    exactKeys(candidate, [
      'candidateId',
      'label',
      'patternType',
      'classification',
      'confidence',
      'occurrences',
      'sessions',
      'activeDays',
      'evidence',
      'observedActiveFriction',
      'existingCapability',
      'capabilityMatches',
      'catalogCoverage',
      'repositoryEvidence',
      'priorityBasisPoints',
      'falsePositiveRisks',
    ], `candidates[${index}]`);
    assert.match(candidate.candidateId, /^candidate-[a-f0-9]{16}$/);
    assert.ok([
      'Repeated setup or recovery workflow',
      'Repeated review or release workflow',
      'Repeated traceable delivery workflow',
      'Repeated correction rule',
      'Repeated tool sequence',
      'Recurring workflow',
    ].includes(candidate.label));
    assert.ok([
      'repair-loop',
      'review-workflow',
      'delivery-workflow',
      'recurring-correction',
      'tool-sequence',
      'generic-workflow',
    ].includes(candidate.patternType));
    assert.ok([
      'root-cause-fix',
      'reuse-existing',
      'extend-existing',
      'consolidate-existing',
      'new-skill-candidate',
      'new-automation-candidate',
      'workflow-fix',
      'insufficient-evidence',
    ].includes(candidate.classification));
    assert.ok(['high', 'medium', 'low'].includes(candidate.confidence));
    assert.ok(Number.isInteger(candidate.occurrences) && candidate.occurrences >= 2);
    assert.ok(Number.isInteger(candidate.sessions) && candidate.sessions >= 2);
    assert.ok(Number.isInteger(candidate.activeDays) && candidate.activeDays >= 1);

    assert.ok(Array.isArray(candidate.evidence) && candidate.evidence.length >= 2);
    for (const [evidenceIndex, evidence] of candidate.evidence.entries()) {
      exactKeys(evidence, [
        'evidenceId',
        'sourceId',
        'sessionAlias',
        'day',
        'recordOrdinals',
        'ruleId',
      ], `candidates[${index}].evidence[${evidenceIndex}]`);
      assert.match(evidence.evidenceId, /^evidence-[a-f0-9]{20}$/);
      assert.match(evidence.sourceId, /^source-[a-f0-9]{12}$/);
      assert.match(evidence.sessionAlias, /^session-[0-9]{3,}$/);
      assert.match(evidence.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Array.isArray(evidence.recordOrdinals));
      assert.ok(evidence.recordOrdinals.length >= 1);
      assert.ok(evidence.recordOrdinals.every(
        (ordinal) => Number.isInteger(ordinal) && ordinal >= 1,
      ));
      assert.match(evidence.ruleId, /^detector\.[a-z0-9.-]+\.v1$/);
    }

    exactKeys(candidate.observedActiveFriction, [
      'lowerSeconds',
      'upperSeconds',
      'method',
      'confidence',
    ], `candidates[${index}].observedActiveFriction`);
    assert.ok(Number.isInteger(candidate.observedActiveFriction.lowerSeconds));
    assert.ok(candidate.observedActiveFriction.lowerSeconds >= 0);
    assert.ok(Number.isInteger(candidate.observedActiveFriction.upperSeconds));
    assert.ok(candidate.observedActiveFriction.upperSeconds >= 0);
    assert.equal(candidate.observedActiveFriction.method, 'capped-active-intervals-v1');
    assert.ok(['medium', 'low', 'unavailable'].includes(
      candidate.observedActiveFriction.confidence,
    ));

    if (candidate.existingCapability !== null) {
      exactKeys(candidate.existingCapability, [
        'name',
        'match',
        'reason',
      ], `candidates[${index}].existingCapability`);
      assert.ok(candidate.existingCapability.name.length >= 1);
      assert.ok(['reuse', 'extend', 'possible-overlap'].includes(
        candidate.existingCapability.match,
      ));
      assert.ok(candidate.existingCapability.reason.length >= 1);
    }
    assert.ok(Array.isArray(candidate.capabilityMatches));
    assert.ok(candidate.capabilityMatches.length <= 3);
    for (const match of candidate.capabilityMatches) {
      exactKeys(match, [
        'capabilityId',
        'name',
        'match',
        'reason',
        'sourceTypes',
      ], `candidates[${index}].capabilityMatches`);
      assert.match(match.capabilityId, /^capability-[a-f0-9]{16}$/);
      assert.ok(match.name.length >= 1);
      assert.ok(['reuse', 'extend', 'possible-overlap'].includes(match.match));
      assert.ok(match.reason.length >= 1);
      assert.ok(Array.isArray(match.sourceTypes) && match.sourceTypes.length >= 1);
    }
    assert.ok(['none', 'partial', 'complete'].includes(candidate.catalogCoverage));
    exactKeys(candidate.repositoryEvidence, [
      'status',
      'events',
      'repositories',
      'pullRequests',
      'failedChecks',
    ], `candidates[${index}].repositoryEvidence`);
    assert.ok(['available', 'unavailable'].includes(candidate.repositoryEvidence.status));
    for (const key of ['events', 'repositories', 'pullRequests', 'failedChecks']) {
      assert.ok(Number.isInteger(candidate.repositoryEvidence[key]));
      assert.ok(candidate.repositoryEvidence[key] >= 0);
    }
    assert.ok(Number.isInteger(candidate.priorityBasisPoints));
    assert.ok(candidate.priorityBasisPoints >= 0 && candidate.priorityBasisPoints <= 10_000);
    assert.ok(
      Array.isArray(candidate.falsePositiveRisks)
      && candidate.falsePositiveRisks.length >= 1
      && candidate.falsePositiveRisks.every(
        (risk) => typeof risk === 'string' && risk.length >= 1,
      ),
    );
  }

  exactKeys(report.excluded, [
    'controlMessages',
    'belowEvidenceThreshold',
    'intentionalVerificationLoops',
    'candidateCap',
    'evidenceItems',
    'workLimitEvents',
    'duplicateSources',
    'duplicateCatalogs',
    'duplicateActivitySources',
  ], 'excluded');
  for (const [key, value] of Object.entries(report.excluded)) {
    assert.ok(Number.isInteger(value) && value >= 0, `excluded.${key} is invalid`);
  }

  exactKeys(report.context, [
    'estateManifest',
    'capabilityCatalogs',
    'repositoryActivitySources',
    'catalogCoverage',
  ], 'context');
  assert.ok(
    report.context.estateManifest === null ||
      typeof report.context.estateManifest === 'object',
  );
  assert.ok(Array.isArray(report.context.capabilityCatalogs));
  assert.ok(Array.isArray(report.context.repositoryActivitySources));
  assert.ok(['none', 'partial', 'complete'].includes(report.context.catalogCoverage));

  exactKeys(report.replay, [
    'analyzerVersion',
    'analysisFingerprint',
  ], 'replay');
  assert.equal(report.replay.analyzerVersion, '2');
  assert.match(report.replay.analysisFingerprint, /^sha256:[a-f0-9]{64}$/);

  assert.ok(Array.isArray(report.diagnostics));
  for (const [index, diagnostic] of report.diagnostics.entries()) {
    exactKeys(diagnostic, [
      'sourceId',
      'status',
      'stage',
      'code',
      'acceptedRecords',
      'skippedRecords',
      'message',
    ], `diagnostics[${index}]`);
    assert.match(diagnostic.sourceId, /^source-[a-f0-9]{12}$/);
    assert.ok(['partial', 'failed'].includes(diagnostic.status));
    assert.ok(['read', 'parse', 'normalize', 'redact', 'mine', 'estate', 'catalog', 'activity'].includes(
      diagnostic.stage,
    ));
    assert.match(diagnostic.code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(Number.isInteger(diagnostic.acceptedRecords));
    assert.ok(diagnostic.acceptedRecords >= 0);
    assert.ok(Number.isInteger(diagnostic.skippedRecords));
    assert.ok(diagnostic.skippedRecords >= 0);
    assert.ok(typeof diagnostic.message === 'string' && diagnostic.message.length >= 1);
  }
}

function internalEvent({
  session,
  day,
  second = 0,
  ordinal,
  repair = false,
  correctionTopic = null,
}) {
  const timestamp = Date.parse(`${day}T00:00:00.000Z`) + second * 1000;
  return {
    sourceId: 'source-aaaaaaaaaaaa',
    ordinal,
    eventIndex: 0,
    sessionKey: session,
    timestamp: new Date(timestamp).toISOString(),
    timestampMs: timestamp,
    day,
    role: 'user',
    toolCategory: null,
    statusError: false,
    durationMs: null,
    features: {
      isControl: false,
      repair,
      review: false,
      delivery: false,
      correction: correctionTopic !== null,
      correctionTopics: correctionTopic === null ? [] : [correctionTopic],
      verificationOnly: false,
      tokenHashes: correctionTopic === null ? [] : [`token-${correctionTopic}`],
    },
  };
}

function treeSnapshot(root) {
  const entries = [];
  function visit(directory, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const childRelative = path.join(relative, name);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        entries.push({
          path: `${childRelative}/`,
          type: 'directory',
          mode: stat.mode & 0o777,
        });
        visit(absolute, childRelative);
      } else {
        entries.push({
          path: childRelative,
          type: stat.isSymbolicLink() ? 'symlink' : 'file',
          mode: stat.mode & 0o777,
          size: stat.size,
          digest: stat.isFile()
            ? createHash('sha256').update(readFileSync(absolute)).digest('hex')
            : undefined,
        });
      }
    }
  }
  visit(root);
  return entries;
}

function assertClosedFailure(result, label) {
  assert.equal(result.error, undefined, `${label} did not start`);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  if (result.stdout.trim() === '') return;
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    assert.doesNotMatch(result.stdout, /candidate-[a-f0-9]{16}/);
    return;
  }
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.candidates, []);
  assert.equal(report.summary?.acceptedRecords ?? 0, 0);
}

test('publishes the complete observe API and stableStringify ignores object insertion order', () => {
  for (const name of REQUIRED_EXPORTS) {
    assert.equal(typeof engine[name], 'function', `${name} must be exported`);
  }
  const first = { z: 3, a: { y: 2, b: 1 }, list: [{ d: 4, c: 3 }] };
  const second = { list: [{ c: 3, d: 4 }], a: { b: 1, y: 2 }, z: 3 };
  assert.equal(engine.stableStringify(first), engine.stableStringify(second));
  assert.deepEqual(JSON.parse(engine.stableStringify(first)), first);
});

test('every explicit provider adapter normalizes its native fixture', () => {
  const expected = new Map([
    ['normalized', { acceptedRecords: 7, sessions: 4, activeDays: 3 }],
    ['copilot', { acceptedRecords: 4, sessions: 4, activeDays: 3 }],
    ['claude', { acceptedRecords: 8, sessions: 4, activeDays: 3 }],
    ['codex', { acceptedRecords: 9, sessions: 3, activeDays: 2 }],
    ['openrappter', { acceptedRecords: 6, sessions: 3, activeDays: 1 }],
  ]);
  for (const [source, name] of PROVIDERS) {
    const { report } = successfulReport({
      inputs: [fixture(name)],
      source,
    });
    assert.equal(report.sources.length, 1, `${source} source count`);
    assert.equal(report.sources[0].sourceType, source);
    assert.equal(report.sources[0].status, 'ok', `${source} source status`);
    assert.equal(
      report.sources[0].acceptedRecords,
      expected.get(source).acceptedRecords,
      `${source} accepted-record count`,
    );
    assert.equal(report.sources[0].skippedRecords, 0, `${source} skipped valid records`);
    assert.equal(report.summary.sessions, expected.get(source).sessions, `${source} sessions`);
    assert.equal(report.summary.activeDays, expected.get(source).activeDays, `${source} days`);
  }
});

test('every provider adapter reports a partially malformed source', () => {
  const partials = [
    ['normalized', 'partial-normalized.jsonl'],
    ['copilot', 'partial-copilot.jsonl'],
    ['claude', 'partial-claude.jsonl'],
    ['codex', 'partial-codex.jsonl'],
    ['openrappter', 'partial-openrappter.json'],
  ];
  for (const [source, name] of partials) {
    const result = runCli({ inputs: [fixture(name)], source });
    const report = parseStdoutReport(result, `${source} partial fixture`);
    assert.equal(result.status, 0);
    assert.equal(report.status, 'partial');
    assert.equal(report.sources[0].status, 'partial');
    assert.ok(report.sources[0].acceptedRecords > 0);
    assert.ok(report.sources[0].skippedRecords > 0);
    assert.ok(report.diagnostics.some(
      ({ status, acceptedRecords, skippedRecords }) =>
        status === 'partial' && acceptedRecords > 0 && skippedRecords > 0,
    ));
  }
});

test('auto detection recognizes every selected provider fixture', () => {
  const { report } = fullReport();
  assert.equal(report.sources.length, FULL_INPUTS.length);
  assert.ok(report.sources.every(({ status }) => status === 'ok'));
  assert.ok(report.sources.every(({ acceptedRecords }) => acceptedRecords > 0));
  assert.deepEqual(
    report.sources.map(({ sourceType }) => sourceType).sort(),
    ['claude', 'codex', 'copilot', 'normalized', 'normalized', 'openrappter'],
  );
  assert.equal(report.summary.sessions, 25);
});

test('timestamps are strict RFC 3339 and reports do not depend on host timezone', () => {
  assert.throws(
    () => engine.parseArgs([
      'observe',
      '--input',
      'history.jsonl',
      '--since',
      '2026-02-31T00:00:00Z',
    ]),
    /valid RFC 3339/,
  );
  const timezoneLess = engine.normalizeRecord({
    sessionId: 'timezone-less',
    timestamp: '2026-08-21T23:30:00',
    role: 'user',
    text: 'Inspect this fictional workflow.',
  }, { source: 'normalized' });
  assert.equal(timezoneLess.errorCode, 'INVALID_TIMESTAMP');

  const utc = fullReport({ env: { TZ: 'UTC' } }).bytes;
  const pacific = fullReport({ env: { TZ: 'America/Los_Angeles' } }).bytes;
  assert.equal(pacific, utc);
});

test('Codex response item IDs remain messages inside one rollout session', () => {
  const { bytes, report } = successfulReport({
    inputs: [fixture('codex-response-items.jsonl')],
    source: 'codex',
  });
  assert.equal(report.summary.sessions, 1);
  assert.equal(report.summary.activeDays, 3);
  assert.equal(report.summary.highConfidenceCandidateCount, 0);
  assert.ok(report.candidates.every(({ confidence }) => confidence !== 'high'));
  assert.doesNotMatch(bytes, /fictional-message-|one-fictional-codex-session/);
});

test('finds a high-confidence, multi-session, multi-day Windows setup repair', () => {
  const { report } = fullReport();
  const repair = report.candidates.find(
    ({ patternType }) => patternType === 'repair-loop',
  );
  assert.ok(repair, 'the repeated repair control must produce a candidate');
  assert.equal(repair.label, 'Repeated setup or recovery workflow');
  assert.equal(repair.confidence, 'high');
  assert.ok(repair.sessions >= 4, `repair sessions=${repair.sessions}`);
  assert.ok(repair.activeDays >= 3, `repair activeDays=${repair.activeDays}`);
  assert.ok(repair.occurrences >= 4, `repair occurrences=${repair.occurrences}`);
});

test('fictional field-shaped language separates deployment repair from release review', () => {
  const { report } = successfulReport({
    inputs: [fixture('field-shaped.jsonl')],
    source: 'copilot',
    skillsRoot: SKILLS_ROOT,
  });
  const repair = report.candidates.find(
    ({ patternType }) => patternType === 'repair-loop',
  );
  const review = report.candidates.find(
    ({ patternType }) => patternType === 'review-workflow',
  );
  assert.equal(repair?.classification, 'root-cause-fix');
  assert.equal(repair?.confidence, 'high');
  assert.equal(repair?.sessions, 3);
  assert.equal(repair?.activeDays, 3);
  assert.equal(repair?.existingCapability, null);
  assert.equal(review?.classification, 'reuse-existing');
  assert.equal(review?.sessions, 3);
  assert.equal(report.excluded.controlMessages, 3);
});

test('deduplicates repeated release review work to the release-reviewer skill', () => {
  const { report } = fullReport();
  const review = report.candidates.find(
    ({ patternType }) => patternType === 'review-workflow',
  );
  assert.ok(review, 'the release-review control must produce a candidate');
  assert.ok(review.existingCapability, 'review candidate did not match the fixture skill');
  assert.equal(review.existingCapability.name, 'release-reviewer');
  assert.ok(['reuse', 'extend'].includes(review.existingCapability.match));
  assert.ok(['reuse-existing', 'extend-existing'].includes(review.classification));
});

test('seven exact bare continue controls are excluded and never become a proposal', () => {
  const { report } = successfulReport({
    inputs: [fixture('controls-only.jsonl')],
    source: 'normalized',
  });
  assert.equal(report.excluded.controlMessages, 7);
  assert.equal(report.summary.candidateCount, 0);
  assert.deepEqual(report.candidates, []);
});

test('unrelated controls and deliberately insufficient thresholds cannot manufacture high confidence', () => {
  const negative = successfulReport({
    inputs: [fixture('negative-control.jsonl')],
    source: 'normalized',
  }).report;
  assert.equal(negative.summary.highConfidenceCandidateCount, 0);
  assert.ok(negative.candidates.every(({ confidence }) => confidence !== 'high'));

  const insufficient = successfulReport({
    inputs: [fixture('insufficient-repair.jsonl')],
    source: 'normalized',
    extra: ['--min-sessions', '2', '--min-days', '1'],
  }).report;
  assert.equal(insufficient.summary.sessions, 2);
  assert.equal(insufficient.summary.activeDays, 1);
  assert.equal(insufficient.summary.highConfidenceCandidateCount, 0);
  assert.ok(insufficient.candidates.every(({ confidence }) => confidence !== 'high'));
});

test('intentional red-green verification loops are counted as exclusions, not promoted', () => {
  const { report } = fullReport();
  assert.ok(
    report.excluded.intentionalVerificationLoops >= 3,
    `excluded intentional loops=${report.excluded.intentionalVerificationLoops}`,
  );
});

test('all high-confidence candidates retain the non-negotiable evidence floor', () => {
  const { report } = fullReport();
  const high = report.candidates.filter(({ confidence }) => confidence === 'high');
  assert.ok(high.length >= 1, 'fixture must exercise the high-confidence path');
  for (const candidate of high) {
    assert.ok(candidate.sessions >= 3, `${candidate.candidateId} has too few sessions`);
    assert.ok(candidate.activeDays >= 2, `${candidate.candidateId} has too few days`);
  }
});

test('the complete report obeys the closed contract and the runtime candidate cap', () => {
  const { report } = fullReport();
  assert.equal(CONTRACT.properties.candidates.maxItems, 5);
  assert.equal(CONTRACT['x-openrappter-contract'].maximumCandidates, 5);
  assert.ok(report.candidates.length >= 2, 'cap assertion needs real candidates');
  assert.ok(report.candidates.length <= 5);
  assertReportContract(report);
});

test('observed friction ranges are ordered and never become speculative time-saved claims', () => {
  const { bytes, report } = fullReport();
  assert.ok(report.candidates.length >= 1);
  for (const candidate of report.candidates) {
    const friction = candidate.observedActiveFriction;
    assert.ok(
      friction.lowerSeconds <= friction.upperSeconds,
      `${candidate.candidateId} has an inverted friction range`,
    );
  }
  assert.doesNotMatch(bytes, /\btime[- ]saved\b/i);
  assert.doesNotMatch(bytes, /\bsav(?:e|ed|ing)s?\s+\d+\s*(?:seconds?|minutes?|hours?)\b/i);
});

test('twenty clean runs are byte-identical', () => {
  const cwd = temporaryDirectory('determinism');
  const outputs = [];
  for (let index = 0; index < 20; index += 1) {
    outputs.push(fullReport({ cwd }).bytes);
  }
  assert.ok(outputs[0].length > 100, 'determinism control produced a trivial report');
  for (const bytes of outputs.slice(1)) assert.equal(bytes, outputs[0]);
});

test('permuting input source order does not change the normalized report', () => {
  const cwd = temporaryDirectory('permutation');
  const forward = fullReport({ cwd }).report;
  const reverse = successfulReport({
    cwd,
    inputs: [...FULL_INPUTS].reverse(),
    source: 'auto',
    skillsRoot: SKILLS_ROOT,
  }).report;
  assert.equal(engine.stableStringify(reverse), engine.stableStringify(forward));
});

test('multiple skill roots are collision-checked deterministically in either order', () => {
  const extraRoot = path.join(FIXTURES, 'skills-extra');
  const forward = successfulReport({
    inputs: [fixture('field-shaped.jsonl')],
    source: 'copilot',
    skillsRoots: [SKILLS_ROOT, extraRoot],
  }).report;
  const reverse = successfulReport({
    inputs: [fixture('field-shaped.jsonl')],
    source: 'copilot',
    skillsRoots: [extraRoot, SKILLS_ROOT],
  }).report;
  assert.equal(forward.scope.skillsRootsCount, 2);
  assert.equal(engine.stableStringify(reverse), engine.stableStringify(forward));
  const review = forward.candidates.find(({ patternType }) => patternType === 'review-workflow');
  assert.equal(review?.existingCapability?.name, 'release-reviewer');
});

test('candidate and per-gap friction caps are enforced by overflow controls', () => {
  const correctionEvents = [];
  let ordinal = 1;
  for (let cluster = 0; cluster < 6; cluster += 1) {
    correctionEvents.push(
      internalEvent({
        session: `correction-${cluster}-a`,
        day: '2026-07-01',
        ordinal: ordinal++,
        correctionTopic: `topic-${cluster}`,
      }),
      internalEvent({
        session: `correction-${cluster}-b`,
        day: '2026-07-02',
        ordinal: ordinal++,
        correctionTopic: `topic-${cluster}`,
      }),
    );
  }
  const cappedCandidates = engine.analyzeHistory(correctionEvents);
  assert.equal(cappedCandidates.candidates.length, 5);
  assert.ok(cappedCandidates.candidates.every(
    ({ patternType }) => patternType === 'recurring-correction',
  ));

  const repairEvents = [];
  ordinal = 1;
  for (let index = 0; index < 3; index += 1) {
    const day = `2026-07-0${index + 1}`;
    repairEvents.push(
      internalEvent({
        session: `repair-gap-${index}`,
        day,
        ordinal: ordinal++,
        repair: true,
      }),
      internalEvent({
        session: `repair-gap-${index}`,
        day,
        second: 1_000,
        ordinal: ordinal++,
        repair: true,
      }),
    );
  }
  const repair = engine.analyzeHistory(repairEvents).candidates.find(
    ({ patternType }) => patternType === 'repair-loop',
  );
  assert.ok(repair);
  assert.equal(repair.observedActiveFriction.lowerSeconds, 900);
  assert.equal(repair.observedActiveFriction.upperSeconds, 900);
});

test('observe leaves every selected source byte and fixture tree entry unchanged', () => {
  const before = treeSnapshot(FIXTURES);
  const { report } = fullReport();
  assert.ok(report.summary.acceptedRecords > 0, 'mutation check must process records');
  const expectedDigests = FULL_INPUTS.map(
    (input) => `sha256:${createHash('sha256').update(readFileSync(input)).digest('hex')}`,
  ).sort();
  assert.deepEqual(
    report.sources.map(({ sourceDigest }) => sourceDigest).sort(),
    expectedDigests,
    'reported source hashes must describe the exact selected bytes',
  );
  const after = treeSnapshot(FIXTURES);
  assert.deepEqual(after, before);
});

test('report and diagnostics contain no raw secrets, PII, paths, URLs, or prompt tripwires', () => {
  const clean = fullReport();
  const dynamicDirectory = temporaryDirectory('dynamic-secrets');
  const dynamicInput = path.join(dynamicDirectory, 'sensitive.jsonl');
  const syntheticSecrets = [
    ['sk', 'proj', 'FICTIONAL0123456789abcdef0123456789'].join('-'),
    ['gh', 'p_', 'FICTIONAL012345678901234567890123456'].join(''),
    [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiJmaWN0aW9uYWwifQ',
      'ZmljdGlvbmFsLXNpZ25hdHVyZQ',
    ].join('.'),
  ];
  writeFileSync(
    dynamicInput,
    `${JSON.stringify({
      sessionId: 'dynamic-sensitive-session',
      timestamp: '2026-06-20T12:00:00.000Z',
      role: 'user',
      text: `Inspect this inert fixture: ${syntheticSecrets.join(' ')}`,
    })}\n`,
    { mode: 0o600 },
  );
  const sensitiveResult = runCli({
    inputs: [dynamicInput],
    source: 'normalized',
  });
  assert.equal(sensitiveResult.status, 0);
  const malformedResult = runCli({
    inputs: [fixture('malformed.jsonl')],
    source: 'normalized',
  });
  const malformed = parseStdoutReport(malformedResult, 'malformed observe command');
  const serialized = [
    clean.bytes,
    clean.stderr,
    sensitiveResult.stdout,
    sensitiveResult.stderr,
    engine.stableStringify(malformed),
    malformedResult.stderr,
  ].join('\n');

  for (const forbidden of [
    ...syntheticSecrets,
    'rowan.test@example.invalid',
    'C:\\\\Users\\\\Rowan',
    'D:\\\\Fictional\\\\Orchid',
    '/Users/rowan/',
    'https://setup.fictional.invalid',
    'https://exfiltration.fictional.invalid',
    'PINEAPPLE-REPAIR',
    'MARIGOLD-REVIEW',
    'INTENTIONAL-VERIFY',
    'INJECTION-TRIPWIRE',
    'CEDAR-NEGATIVE',
    'norm-repair-01',
    'copilot-repair-02',
    'claude-repair-03',
    'codex-repair-04',
    'flight-repair-05',
    'flight-trace-repair-05',
    'claude-r3-u1',
    'flight-repair-u1',
    FIXTURES,
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `private fixture material leaked: ${forbidden}`,
    );
  }
  assert.doesNotMatch(serialized, /https?:\/\//i);
  assert.doesNotMatch(serialized, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  assert.doesNotMatch(serialized, /\b(?:sk-|gh[opusr]_)[A-Za-z0-9_-]{12,}\b/);
  assert.doesNotMatch(serialized, /(?:^|["'\s])\/(?:Users|home|private|var|tmp)\//);
  assert.doesNotMatch(serialized, /\b[A-Za-z]:\\\\[^"'\s]+/);
});

test('hostile transcript instructions remain inert and cannot create a sentinel', () => {
  const cwd = temporaryDirectory('injection');
  const sentinel = path.join(cwd, 'rapter-clever-girl-injection-sentinel');
  assert.equal(existsSync(sentinel), false);
  const { report } = successfulReport({
    cwd,
    inputs: [fixture('codex-rollout.jsonl')],
    source: 'codex',
  });
  assert.ok(report.summary.acceptedRecords > 0);
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(readdirSync(cwd), []);
});

test('malformed and truncated rows yield partial status with exact accounting', () => {
  const result = runCli({
    inputs: [fixture('malformed.jsonl')],
    source: 'normalized',
  });
  const report = parseStdoutReport(result, 'malformed observe command');
  assert.equal(report.status, 'partial');
  assert.equal(report.sources.length, 1);
  assert.equal(report.sources[0].status, 'partial');
  assert.equal(report.sources[0].acceptedRecords, 3);
  assert.equal(report.sources[0].skippedRecords, 3);
  assert.equal(report.summary.acceptedRecords, 3);
  assert.equal(report.summary.skippedRecords, 3);
  assert.ok(report.diagnostics.length >= 1);
  assert.ok(report.diagnostics.some(
    ({ acceptedRecords, skippedRecords }) =>
      acceptedRecords === 3 && skippedRecords === 3,
  ));
  assertReportContract(report);
});

test('missing and empty inputs fail closed without proposals', () => {
  assertClosedFailure(runCli({ inputs: [] }), 'missing input');
  assertClosedFailure(runCli({
    inputs: [fixture('empty.jsonl')],
    source: 'normalized',
  }), 'empty input');
});

test('source symlinks and non-file inputs fail closed', () => {
  const cwd = temporaryDirectory('source-kinds');
  const linkedInput = path.join(cwd, 'linked-history.jsonl');
  symlinkSync(fixture('normalized.jsonl'), linkedInput);

  for (const [input, code] of [
    [linkedInput, 'SOURCE_SYMLINK_REFUSED'],
    [cwd, 'SOURCE_NOT_FILE'],
  ]) {
    const result = runCli({
      cwd,
      inputs: [input],
      source: 'normalized',
    });
    const report = parseStdoutReport(result, `refused input ${code}`);
    assert.equal(result.status, 1);
    assert.equal(report.status, 'failed');
    assert.equal(report.summary.acceptedRecords, 0);
    assert.deepEqual(report.candidates, []);
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === code));
  }
});

test('descriptor-safe reads reject symlink and regular-file swaps after lstat', async () => {
  const cwd = temporaryDirectory('source-swap');
  const target = path.join(cwd, 'target.jsonl');
  writeFileSync(target, '{"safe":true}\n');

  const symlinkSource = path.join(cwd, 'symlink-source.jsonl');
  const symlinkOriginal = path.join(cwd, 'symlink-original.jsonl');
  writeFileSync(symlinkSource, '{"selected":true}\n');
  await assert.rejects(
    engine.openRegularFileNoFollow(symlinkSource, {}, {
      afterLstat: async () => {
        renameSync(symlinkSource, symlinkOriginal);
        symlinkSync(target, symlinkSource);
      },
    }),
  );

  const swappedSource = path.join(cwd, 'swapped-source.jsonl');
  const swappedOriginal = path.join(cwd, 'swapped-original.jsonl');
  const replacement = path.join(cwd, 'replacement.jsonl');
  writeFileSync(swappedSource, '{"selected":true}\n');
  writeFileSync(replacement, '{"replacement":true}\n');
  await assert.rejects(
    engine.openRegularFileNoFollow(swappedSource, {}, {
      afterLstat: async () => {
        renameSync(swappedSource, swappedOriginal);
        renameSync(replacement, swappedSource);
      },
    }),
    /SOURCE_CHANGED_DURING_OPEN/,
  );

  const growingSource = path.join(cwd, 'growing-source.jsonl');
  writeFileSync(growingSource, '{"selected":true}\n');
  const growingHandle = await engine.openRegularFileNoFollow(growingSource);
  try {
    await assert.rejects(
      engine.readHandleBounded(
        growingHandle,
        1_024,
        'SOURCE_TOO_LARGE',
        'SOURCE_CHANGED_DURING_READ',
        {
          afterStat: async () => {
            appendFileSync(growingSource, '{"grew":true}\n');
          },
        },
      ),
      /SOURCE_CHANGED_DURING_READ/,
    );
  } finally {
    await growingHandle.close();
  }

  const preReadGrowth = path.join(cwd, 'pre-read-growth.jsonl');
  writeFileSync(preReadGrowth, '{"selected":true}\n');
  const preReadHandle = await engine.openRegularFileNoFollow(preReadGrowth);
  try {
    const reservedSize = (await preReadHandle.stat()).size;
    appendFileSync(preReadGrowth, '{"grew-before-read":true}\n');
    await assert.rejects(
      engine.readHandleBounded(
        preReadHandle,
        1_024,
        'SOURCE_TOO_LARGE',
        'SOURCE_CHANGED_DURING_READ',
        { expectedSize: reservedSize },
      ),
      /SOURCE_CHANGED_DURING_READ/,
    );
  } finally {
    await preReadHandle.close();
  }
});

test('explicit output cannot alias, overwrite, or enter selected source/catalog scope', async () => {
  const cwd = temporaryDirectory('output-scope');
  const history = path.join(cwd, 'History.jsonl');
  copyFileSync(fixture('normalized.jsonl'), history);
  const before = readFileSync(history);

  for (const input of [history, './History.jsonl']) {
    const result = runCli({
      cwd,
      inputs: [input],
      source: 'normalized',
      extra: ['--output', history],
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /aliases an explicitly selected source/);
    assert.deepEqual(readFileSync(history), before);
  }

  const parentAlias = path.join(cwd, 'history-parent-alias');
  symlinkSync(cwd, parentAlias, 'dir');
  const aliasedHistory = path.join(parentAlias, path.basename(history));
  const symlinkParentResult = runCli({
    cwd,
    inputs: [history],
    source: 'normalized',
    extra: ['--output', aliasedHistory],
  });
  assert.equal(symlinkParentResult.status, 2);
  assert.match(symlinkParentResult.stderr, /aliases an explicitly selected source/);
  assert.deepEqual(readFileSync(history), before);

  await assert.rejects(
    engine.validateOutputScope({
      output: path.join(cwd, 'history.jsonl'),
      inputs: [history],
      skillsRoots: [],
    }, 'darwin'),
    /aliases an explicitly selected source/,
  );
  await assert.rejects(
    engine.validateOutputScope({
      output: path.join(cwd, 'windows-report.json'),
      inputs: [history],
      skillsRoots: [],
    }, 'win32'),
    /not supported on Windows/,
  );

  const skillsRoot = path.join(cwd, 'skills');
  cpSync(SKILLS_ROOT, skillsRoot, { recursive: true });
  const insideSkills = path.join(skillsRoot, 'observe.json');
  const skillsResult = runCli({
    cwd,
    inputs: [history],
    source: 'normalized',
    skillsRoot,
    extra: ['--output', insideSkills],
  });
  assert.equal(skillsResult.status, 2);
  assert.match(skillsResult.stderr, /outside every selected skill root/);
  assert.equal(existsSync(insideSkills), false);

  const existingOutput = path.join(cwd, 'existing-report.json');
  writeFileSync(existingOutput, 'do not replace', { mode: 0o600 });
  const existingResult = runCli({
    cwd,
    inputs: [history],
    source: 'normalized',
    extra: ['--output', existingOutput],
  });
  assert.equal(existingResult.status, 2);
  assert.match(existingResult.stderr, /refusing to replace an existing filesystem entry/);
  assert.equal(readFileSync(existingOutput, 'utf8'), 'do not replace');
});

test('an explicit output file is exactly private under a restrictive hostile umask', () => {
  const cwd = temporaryDirectory('permissions');
  chmodSync(cwd, 0o777);
  const output = path.join(cwd, 'observe.json');
  const result = runCliWithUmask(0o377, {
    cwd,
    inputs: FULL_INPUTS,
    source: 'auto',
    skillsRoot: SKILLS_ROOT,
    extra: ['--output', output],
  });
  assert.equal(
    result.status,
    0,
    `output command failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(existsSync(output), true);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  assertReportContract(report);
});

test('concurrent writers cannot replace the same explicit output', async () => {
  const cwd = temporaryDirectory('concurrent-output');
  const output = path.join(cwd, 'observe.json');
  const options = {
    cwd,
    inputs: FULL_INPUTS,
    source: 'auto',
    skillsRoot: SKILLS_ROOT,
    extra: ['--output', output],
  };
  const results = await Promise.all([runCliAsync(options), runCliAsync(options)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 2]);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assertReportContract(JSON.parse(readFileSync(output, 'utf8')));
});
