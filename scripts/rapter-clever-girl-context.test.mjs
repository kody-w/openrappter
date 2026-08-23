import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { EVIDENCE_LIMITS } from './rapter-clever-girl-context.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = path.join(SCRIPT_DIR, 'rapter-clever-girl.mjs');
const FIXTURES = path.join(SCRIPT_DIR, 'fixtures', 'rapter-clever-girl');
const SKILLS_ROOT = path.join(FIXTURES, 'skills');
const ESTATE_MANIFEST = path.join(FIXTURES, 'estate-manifest.json');
const CAPABILITY_CATALOG = path.join(FIXTURES, 'capability-catalog.json');
const REPOSITORY_ACTIVITY = path.join(FIXTURES, 'repository-activity.jsonl');
const FULL_INPUTS = [
  'normalized.jsonl',
  'copilot-export.jsonl',
  'claude.jsonl',
  'codex-rollout.jsonl',
  'openrappter-flight.json',
  'controls-only.jsonl',
].map((name) => path.join(FIXTURES, name));
const TEMPORARY_DIRECTORIES = [];
const engine = await import(pathToFileURL(ENGINE_PATH).href);

afterEach(() => {
  for (const directory of TEMPORARY_DIRECTORIES.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `clever-girl-context-${label}-`));
  TEMPORARY_DIRECTORIES.push(directory);
  return directory;
}

function cliArgs({
  inputs = FULL_INPUTS,
  activities = [REPOSITORY_ACTIVITY],
  catalogs = [CAPABILITY_CATALOG],
  estate = ESTATE_MANIFEST,
  skillsRoot = SKILLS_ROOT,
  extra = [],
} = {}) {
  const args = [ENGINE_PATH, 'observe'];
  for (const input of inputs) args.push('--input', input);
  args.push('--source', 'auto');
  for (const activity of activities) args.push('--activity', activity);
  for (const catalog of catalogs) args.push('--capability-catalog', catalog);
  if (estate) args.push('--estate-manifest', estate);
  if (skillsRoot) args.push('--skills-root', skillsRoot);
  args.push(...extra);
  return args;
}

function runCli(options = {}) {
  const cwd = options.cwd ?? temporaryDirectory('run');
  return spawnSync(process.execPath, cliArgs(options), {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: cwd,
      USERPROFILE: cwd,
      XDG_CONFIG_HOME: path.join(cwd, 'config'),
      XDG_DATA_HOME: path.join(cwd, 'data'),
      XDG_CACHE_HOME: path.join(cwd, 'cache'),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function reportFor(options = {}) {
  const result = runCli(options);
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  return { result, report: JSON.parse(result.stdout) };
}

test('parses explicit bounded context inputs without implicit discovery', () => {
  const parsed = engine.parseArgs([
    'observe',
    '--input',
    'history.jsonl',
    '--activity',
    'activity.jsonl',
    '--capability-catalog',
    'catalog.json',
    '--estate-manifest',
    'manifest.json',
  ]);
  assert.deepEqual(parsed.activityInputs, ['activity.jsonl']);
  assert.deepEqual(parsed.capabilityCatalogs, ['catalog.json']);
  assert.equal(parsed.estateManifest, 'manifest.json');

  const excessive = ['observe', '--input', 'history.jsonl'];
  for (let index = 0; index <= EVIDENCE_LIMITS.maximumActivityInputs; index += 1) {
    excessive.push('--activity', `activity-${index}.jsonl`);
  }
  assert.throws(() => engine.parseArgs(excessive), /exceeds its supported count/);
});

test('joins recurring session demand with bounded estate supply and repository evidence', () => {
  const { result, report } = reportFor();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.schemaVersion, 'rapter-clever-girl.observe.v2');
  assert.equal(report.status, 'ok');
  assert.equal(report.context.estateManifest.repositoryCount, 3);
  assert.equal(report.context.estateManifest.status, 'ok');
  assert.equal(report.context.capabilityCatalogs.length, 1);
  assert.equal(report.context.repositoryActivitySources.length, 1);
  assert.equal(report.context.catalogCoverage, 'complete');
  assert.equal(report.summary.repositoryActivityRecords, 10);
  assert.ok(report.summary.capabilitiesInspected >= 6);
  assert.match(report.replay.analysisFingerprint, /^sha256:[a-f0-9]{64}$/);

  const review = report.candidates.find(({ patternType }) => patternType === 'review-workflow');
  assert.ok(review);
  assert.ok(review.repositoryEvidence.events >= 3);
  assert.ok(review.repositoryEvidence.repositories >= 3);
  assert.ok(review.capabilityMatches.length >= 2);
  assert.equal(review.classification, 'consolidate-existing');
  assert.equal(review.catalogCoverage, 'complete');
  assert.ok(review.priorityBasisPoints > 0);
  const estateCollision = review.capabilityMatches.find(({ sourceTypes }) =>
    sourceTypes.includes('estate-repository'));
  assert.ok(estateCollision);
  assert.match(estateCollision.name, /^estate-capability-[a-f0-9]{12}$/);
});

test('repository and estate evidence cannot manufacture session demand', () => {
  const { result, report } = reportFor({
    inputs: [path.join(FIXTURES, 'controls-only.jsonl')],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.summary.repositoryActivityRecords, 10);
  assert.equal(report.excluded.controlMessages, 7);
  assert.equal(report.summary.candidateCount, 0);
  assert.deepEqual(report.candidates, []);
});

test('exact duplicate session, activity, and catalog files are excluded before mining', () => {
  const unique = reportFor().report;
  const duplicate = reportFor({
    inputs: [...FULL_INPUTS, FULL_INPUTS[0]],
    activities: [REPOSITORY_ACTIVITY, REPOSITORY_ACTIVITY],
    catalogs: [CAPABILITY_CATALOG, CAPABILITY_CATALOG],
  }).report;

  assert.equal(duplicate.status, 'partial');
  assert.equal(duplicate.excluded.duplicateSources, 1);
  assert.equal(duplicate.excluded.duplicateActivitySources, 1);
  assert.equal(duplicate.excluded.duplicateCatalogs, 1);
  assert.equal(duplicate.sources.length, unique.sources.length);
  assert.equal(duplicate.summary.sessions, unique.summary.sessions);
  assert.equal(
    duplicate.summary.repositoryActivityRecords,
    unique.summary.repositoryActivityRecords,
  );
  assert.equal(duplicate.summary.capabilitiesInspected, unique.summary.capabilitiesInspected);
  assert.deepEqual(
    duplicate.candidates.map(({ candidateId, occurrences, sessions }) => ({
      candidateId,
      occurrences,
      sessions,
    })),
    unique.candidates.map(({ candidateId, occurrences, sessions }) => ({
      candidateId,
      occurrences,
      sessions,
    })),
  );
});

test('invalid estate dimensions fail closed and surface partial coverage', () => {
  const cwd = temporaryDirectory('invalid-estate');
  const invalidManifest = path.join(cwd, 'manifest.json');
  const value = JSON.parse(readFileSync(ESTATE_MANIFEST, 'utf8'));
  value.repos[0].repo = '../escape';
  writeFileSync(invalidManifest, `${JSON.stringify(value)}\n`, { mode: 0o600 });

  const { result, report } = reportFor({ cwd, estate: invalidManifest });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'partial');
  assert.equal(report.context.estateManifest.status, 'failed');
  assert.equal(report.context.catalogCoverage, 'partial');
  assert.ok(report.diagnostics.some(({ code }) => code === 'ESTATE_REPOSITORY_INVALID'));
  assert.equal(result.stdout.includes('../escape'), false);
  assert.equal(result.stdout.includes(invalidManifest), false);
});

test('oversized and symlinked context inputs are rejected without being read', () => {
  const cwd = temporaryDirectory('bounded');
  const oversized = path.join(cwd, 'oversized.jsonl');
  writeFileSync(oversized, '');
  truncateSync(oversized, EVIDENCE_LIMITS.maximumSourceBytes + 1);
  const oversizedResult = reportFor({
    cwd,
    inputs: [oversized],
    activities: [],
    catalogs: [],
    estate: null,
    skillsRoot: null,
  });
  assert.equal(oversizedResult.result.status, 1);
  assert.equal(oversizedResult.report.status, 'failed');
  assert.ok(
    oversizedResult.report.diagnostics.some(({ code }) => code === 'SOURCE_TOO_LARGE'),
  );

  const linkedCatalog = path.join(cwd, 'catalog-link.json');
  symlinkSync(CAPABILITY_CATALOG, linkedCatalog);
  const linkedResult = reportFor({ cwd, catalogs: [linkedCatalog] });
  assert.equal(linkedResult.report.status, 'partial');
  assert.ok(
    linkedResult.report.diagnostics.some(
      ({ code }) => code === 'CAPABILITY_CATALOG_SYMLINK_REFUSED',
    ),
  );
});

test('analysis fingerprints are stable and change when selected evidence changes', () => {
  const cwd = temporaryDirectory('fingerprint');
  const first = reportFor({ cwd }).report;
  const second = reportFor({ cwd }).report;
  assert.equal(second.replay.analysisFingerprint, first.replay.analysisFingerprint);
  assert.deepEqual(second, first);
  const differentSkills = reportFor({
    cwd,
    skillsRoot: path.join(FIXTURES, 'skills-extra'),
  }).report;
  assert.notEqual(
    differentSkills.replay.analysisFingerprint,
    first.replay.analysisFingerprint,
  );

  const changedActivity = path.join(cwd, 'changed-activity.jsonl');
  copyFileSync(REPOSITORY_ACTIVITY, changedActivity);
  writeFileSync(
    changedActivity,
    `${readFileSync(changedActivity, 'utf8')}{"kind":"commit","repository":"fictional/release-d","observedAt":"2026-06-21T12:00:00Z","artifactKey":"commit-1","state":"completed"}\n`,
    { mode: 0o600 },
  );
  const changed = reportFor({ cwd, activities: [changedActivity] }).report;
  assert.notEqual(changed.replay.analysisFingerprint, first.replay.analysisFingerprint);
});

test('the global record budget counts rejected records and stops later sources', () => {
  const boundedMalformed = engine.parseHistoryBytes(
    Buffer.from('not-json\n[]\nstill-not-json\n'),
    { maximumRecords: 2 },
  );
  assert.equal(boundedMalformed.attemptedRecords, 2);
  assert.ok(
    boundedMalformed.issues.some(
      ({ code, count }) => code === 'RECORD_LIMIT_REACHED' && count === 1,
    ),
  );

  const cwd = temporaryDirectory('record-budget');
  const first = path.join(cwd, 'unsupported-a.jsonl');
  const second = path.join(cwd, 'unsupported-b.jsonl');
  const valid = path.join(cwd, 'valid.jsonl');
  writeFileSync(
    first,
    `${Array.from(
      { length: EVIDENCE_LIMITS.maximumRecordsPerSource },
      () => '{"unsupported":"a"}',
    ).join('\n')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    second,
    `${Array.from(
      { length: EVIDENCE_LIMITS.maximumRecordsPerSource },
      () => '{"unsupported":"b"}',
    ).join('\n')}\n`,
    { mode: 0o600 },
  );
  copyFileSync(path.join(FIXTURES, 'normalized.jsonl'), valid);

  const { result, report } = reportFor({
    cwd,
    inputs: [first, second, valid],
    activities: [],
    catalogs: [],
    estate: null,
    skillsRoot: null,
  });
  assert.equal(result.status, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.summary.acceptedRecords, 0);
  assert.ok(
    report.diagnostics.some(({ code }) => code === 'TOTAL_RECORD_LIMIT_REACHED'),
  );
});

test('skill discovery enforces deterministic depth and traversal limits', async () => {
  const cwd = temporaryDirectory('skill-depth');
  const root = path.join(cwd, 'skills');
  let cursor = root;
  mkdirSync(cursor);
  for (let depth = 0; depth <= EVIDENCE_LIMITS.maximumSkillDepth; depth += 1) {
    cursor = path.join(cursor, `depth-${depth}`);
    mkdirSync(cursor);
  }
  writeFileSync(
    path.join(cursor, 'SKILL.md'),
    '---\nname: too-deep\ndescription: Must not be inspected beyond the depth boundary.\n---\n',
    { mode: 0o600 },
  );

  const catalog = await engine.loadSkillCatalog([root]);
  assert.equal(catalog.coverage, 'partial');
  assert.equal(catalog.skills.length, 0);
  assert.ok(
    catalog.diagnostics.some(({ code }) => code === 'SKILL_DEPTH_LIMIT_REACHED'),
  );
  const { report } = reportFor({
    cwd,
    activities: [],
    catalogs: [],
    estate: null,
    skillsRoot: root,
  });
  assert.equal(report.status, 'partial');
  assert.equal(report.context.catalogCoverage, 'partial');
});

test('output scope includes every selected context source', () => {
  const cwd = temporaryDirectory('output-scope');
  const manifestCopy = path.join(cwd, 'manifest.json');
  copyFileSync(ESTATE_MANIFEST, manifestCopy);
  const before = readFileSync(manifestCopy);
  const result = runCli({
    cwd,
    estate: manifestCopy,
    extra: ['--output', manifestCopy],
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /aliases an explicitly selected source/);
  assert.deepEqual(readFileSync(manifestCopy), before);
});

test('text and catalog feature limits produce explicit partial diagnostics', () => {
  const cwd = temporaryDirectory('feature-limits');
  const history = path.join(cwd, 'history.jsonl');
  writeFileSync(
    history,
    `${JSON.stringify({
      sessionId: 'bounded-session',
      timestamp: '2026-06-20T12:00:00Z',
      role: 'user',
      text: `review release gate ${'word '.repeat(60_000)}`,
    })}\n`,
    { mode: 0o600 },
  );
  const catalog = path.join(cwd, 'catalog.json');
  writeFileSync(
    catalog,
    `${JSON.stringify({
      schema: 'rapter-clever-girl.capabilities.v1',
      capabilities: [{
        name: 'bounded-reviewer',
        description: `review release gate ${'detail '.repeat(1_000)}`,
      }],
    })}\n`,
    { mode: 0o600 },
  );

  const { result, report } = reportFor({
    cwd,
    inputs: [history],
    activities: [],
    catalogs: [catalog],
    estate: null,
    skillsRoot: null,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.status, 'partial');
  assert.ok(report.diagnostics.some(({ code }) => code === 'TEXT_LIMIT_REACHED'));
  assert.ok(report.diagnostics.some(({ code }) => code === 'CAPABILITY_CATALOG_PARTIAL'));
});

test('reports never expose repository names, activity identifiers, paths, or catalog prose', () => {
  const { result, report } = reportFor();
  const serialized = JSON.stringify(report);
  for (const forbidden of [
    'fictional/release-a',
    'fictional/release-b',
    'fictional/release-c',
    'rapp-first-run-doctor',
    'rapp-release-train',
    'rapp-workflow-observer',
    'pr-101',
    'pr-102',
    'pr-103',
    'Diagnose setup, installer',
    FIXTURES,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `context material leaked: ${forbidden}`);
  }
  assert.doesNotMatch(result.stdout, /https?:\/\//i);
  assert.doesNotMatch(result.stdout, /(?:^|["'\s])\/(?:Users|home|private|var|tmp)\//);
});
