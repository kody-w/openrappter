import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REPAIR_DOMAINS,
  REPAIR_FACETS,
  parseArgs,
} from './rapter-clever-girl.mjs';
import {
  matchCapabilities,
  mergeCapabilityCatalogs,
  parseCapabilityCatalog,
} from './rapter-clever-girl-context.mjs';
import {
  ObserveReportReaderError,
  readObserveReport,
  supportedObserveReportVersions,
} from './rapter-clever-girl-reader.mjs';

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(TEST_ROOT);
const ENGINE = path.join(TEST_ROOT, 'rapter-clever-girl.mjs');
const FIXTURES = path.join(TEST_ROOT, 'fixtures', 'rapter-clever-girl');
const CONTRACT_CATALOG = path.join(
  FIXTURES,
  'capability-contract-catalog.json',
);
const ESTATE_MANIFEST = path.join(FIXTURES, 'estate-manifest.json');
const WORK_ROOT = path.join(REPO_ROOT, '.test-work');
const WORKSPACES = [];

afterEach(() => {
  for (const directory of WORKSPACES.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspace(label) {
  mkdirSync(WORK_ROOT, { recursive: true });
  const directory = mkdtempSync(path.join(WORK_ROOT, `v3-${label}-`));
  WORKSPACES.push(directory);
  return directory;
}

function row(sessionId, timestamp, text) {
  return { sessionId, timestamp, role: 'user', text };
}

function fixtureInputs(directory) {
  const first = path.join(directory, 'first.jsonl');
  const second = path.join(directory, 'second.jsonl');
  const firstRows = [
    row('dep-a', '2026-08-01T10:00:00Z', 'Install failed because a dependency is missing; repair the package conflict.'),
    row('dep-a', '2026-08-01T10:00:30Z', 'Retry the dependency install fix for the missing package.'),
    row('dep-b', '2026-08-02T10:00:00Z', 'Reinstall the broken dependency and resolve the module conflict.'),
    row('dep-d', '2026-08-03T10:00:00Z', 'Fix the failed package installation dependency conflict.'),
    row('access-a', '2026-08-01T11:00:00Z', 'Authentication failed with permission denied; repair login access.'),
    row('review-a', '2026-08-01T12:00:00Z', 'Review the release candidate and provide a go-no-go release gate.'),
    row('review-b', '2026-08-02T12:00:00Z', 'Review the release gate before merge readiness.'),
    row('generic-a', '2026-08-01T13:00:00Z', 'Fix this repeated build failure again.'),
    row('generic-b', '2026-08-02T13:00:00Z', 'Repair the recurring build failure again.'),
    row('generic-c', '2026-08-03T13:00:00Z', 'Fix the build failure that keeps repeating.'),
  ];
  const secondRows = [
    row('dep-c', '2026-08-04T10:00:00Z', 'Repair a failed dependency installer and missing module.'),
    row('access-b', '2026-08-02T11:00:00Z', 'Login authentication failed; fix denied permission access.'),
    row('access-c', '2026-08-03T11:00:00Z', 'Repair the failed credential authentication and permission issue.'),
    row('review-c', '2026-08-03T12:00:00Z', 'Review release merge gates and issue a go-no-go verdict.'),
  ];
  writeFileSync(
    first,
    `${firstRows.map((value) => JSON.stringify(value)).join('\n')}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    second,
    `${secondRows.map((value) => JSON.stringify(value)).join('\n')}\n`,
    { mode: 0o600 },
  );
  return [first, second];
}

function runV3({
  inputs,
  directory,
  catalog = CONTRACT_CATALOG,
  estate = null,
  sidecar = false,
  minimumSessions = 3,
  minimumDays = 2,
  reportVersion = '3',
} = {}) {
  const cwd = directory ?? workspace('run');
  const selectedInputs = inputs ?? fixtureInputs(cwd);
  const args = [ENGINE, 'observe'];
  for (const input of selectedInputs) args.push('--input', input);
  args.push('--source', 'normalized');
  if (reportVersion !== null) {
    args.push('--report-version', reportVersion);
  }
  args.push(
    '--min-sessions',
    String(minimumSessions),
    '--min-days',
    String(minimumDays),
  );
  if (catalog) args.push('--capability-catalog', catalog);
  if (estate) args.push('--estate-manifest', estate);
  const sidecarPath = sidecar ? path.join(cwd, 'repair-sidecar.json') : null;
  if (sidecarPath) args.push('--facet-sidecar-output', sidecarPath);
  const result = spawnSync(process.execPath, args, {
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
  assert.equal(result.status, 0, result.stderr);
  return {
    bytes: result.stdout,
    report: JSON.parse(result.stdout),
    sidecarPath,
    inputs: selectedInputs,
  };
}

function repairCandidates(report) {
  return report.candidates.filter(
    ({ patternType }) => patternType === 'repair-loop',
  );
}

test('acceptance 1: frozen replay assigns every eligible repair occurrence one closed facet and domain', () => {
  const { report, sidecarPath } = runV3({ sidecar: true });
  const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
  assert.equal(report.schemaVersion, 'rapter-clever-girl.observe.v3');
  assert.equal(
    report.detector.eligibleRepairOccurrences,
    report.detector.assignedRepairOccurrences,
  );
  assert.equal(report.detector.unassignedRepairOccurrences, 0);
  assert.equal(sidecar.assignments.length, report.detector.eligibleRepairOccurrences);
  assert.equal(
    report.detector.facetDomainDistribution.reduce(
      (total, cluster) => total + cluster.occurrences,
      0,
    ),
    report.detector.eligibleRepairOccurrences,
  );
  assert.equal(
    new Set(sidecar.assignments.map(({ assignmentId }) => assignmentId)).size,
    sidecar.assignments.length,
  );
  for (const assignment of sidecar.assignments) {
    assert.ok(REPAIR_FACETS.includes(assignment.facet));
    assert.ok(REPAIR_DOMAINS.includes(assignment.domain));
  }
});

test('acceptance 2: repair candidates are deterministic facet-by-domain clusters with no global bucket', () => {
  const { report, bytes } = runV3();
  const repairs = repairCandidates(report);
  assert.ok(repairs.length >= 3);
  assert.ok(
    repairs.every(
      ({ facet, domain }) =>
        REPAIR_FACETS.includes(facet) && REPAIR_DOMAINS.includes(domain),
    ),
  );
  assert.equal(bytes.includes('repair-loop-v1'), false);
  assert.equal(
    new Set(repairs.map(({ facet, domain }) => `${facet}:${domain}`)).size,
    repairs.length,
  );
  assert.equal(
    new Set(
      report.detector.facetDomainDistribution.map(
        ({ facet, domain }) => `${facet}:${domain}`,
      ),
    ).size,
    report.detector.facetDomainClusterCount,
  );
});

test('acceptance 3: recurrence thresholds remain required for high confidence and promotion', () => {
  const { report } = runV3({ minimumSessions: 5, minimumDays: 5 });
  assert.equal(report.summary.highConfidenceCandidateCount, 0);
  assert.equal(report.summary.promotionEligibleCandidateCount, 0);
  assert.ok(
    report.candidates.every(({ promotion }) =>
      promotion.blockers.includes('recurrence-threshold')),
  );
});

test('acceptance 4: same-session-day duplicates count once and source skew stays visible', () => {
  const { report } = runV3();
  const dependency = repairCandidates(report).find(
    ({ facet, domain }) =>
      facet === 'dependency-recovery' && domain === 'dependencies',
  );
  assert.ok(dependency);
  assert.equal(dependency.occurrences, 4);
  assert.ok(dependency.deduplication.rawSignals > dependency.occurrences);
  assert.ok(dependency.deduplication.duplicateSignals >= 1);
  assert.equal(dependency.sourceSkew.sourceCount, 2);
  assert.equal(dependency.sourceSkew.dominantSourceOccurrences, 3);
  assert.equal(dependency.sourceSkew.dominantSourceBasisPoints, 7500);
});

test('acceptance 5: a single-source cluster is never promotion eligible', () => {
  const directory = workspace('single-source');
  const [first] = fixtureInputs(directory);
  const { report } = runV3({
    directory,
    inputs: [first],
    minimumSessions: 3,
    minimumDays: 2,
  });
  const dependency = repairCandidates(report).find(
    ({ facet }) => facet === 'dependency-recovery',
  );
  assert.ok(dependency);
  assert.equal(dependency.confidence, 'high');
  assert.equal(dependency.sourceSkew.sourceCount, 1);
  assert.equal(dependency.promotion.eligible, false);
  assert.ok(dependency.promotion.blockers.includes('single-source'));
});

test('acceptance 6: manifest-only lexical evidence can never classify as reuse or extension', () => {
  const directory = workspace('manifest-only');
  const inputs = fixtureInputs(directory);
  const { report } = runV3({
    directory,
    inputs,
    catalog: null,
    estate: ESTATE_MANIFEST,
  });
  for (const candidate of report.candidates) {
    for (const match of candidate.capabilityMatches) {
      if (match.sourceTypes.includes('estate-repository')) {
        assert.equal(match.match, 'possible-overlap');
        assert.equal(match.contractQualified, false);
      }
    }
  }
  assert.ok(
    report.candidates.every(
      ({ classification }) =>
        !['reuse-existing', 'extend-existing', 'consolidate-existing'].includes(
          classification,
        ),
    ),
  );
});

test('acceptance 7: reuse and extension require every behavioral contract section and declared tests', () => {
  const qualified = runV3().report.candidates.find(
    ({ patternType }) => patternType === 'review-workflow',
  );
  assert.ok(qualified);
  assert.equal(qualified.classification, 'reuse-existing');
  assert.equal(qualified.existingCapability.contractQualified, true);
  assert.match(qualified.existingCapability.contractVersion, /^\d+\.\d+\.\d+/);
  assert.ok(qualified.existingCapability.contractTestCount >= 1);

  const original = JSON.parse(readFileSync(CONTRACT_CATALOG, 'utf8'));
  for (const section of [
    'inputs',
    'outputs',
    'permissions',
    'failures',
    'limitations',
    'tests',
  ]) {
    const directory = workspace(`mutation-${section}`);
    const mutated = structuredClone(original);
    delete mutated.capabilities[0].behavioralContract[section];
    const catalog = path.join(directory, 'mutated-catalog.json');
    writeFileSync(catalog, `${JSON.stringify(mutated)}\n`, { mode: 0o600 });
    const inputs = fixtureInputs(directory);
    const result = spawnSync(
      process.execPath,
      [
        ENGINE,
        'observe',
        '--input',
        inputs[0],
        '--input',
        inputs[1],
        '--source',
        'normalized',
        '--report-version',
        '3',
        '--capability-catalog',
        catalog,
      ],
      { cwd: directory, encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'partial');
    assert.ok(
      report.diagnostics.some(
        ({ code }) => code === 'CAPABILITY_CONTRACT_INVALID',
      ),
    );
  }

  const conflictDirectory = workspace('mutation-version-conflict');
  const conflictCatalog = structuredClone(original);
  const conflicting = structuredClone(conflictCatalog.capabilities[1]);
  conflicting.behavioralContract.version = '9.0.0';
  conflictCatalog.capabilities.push(conflicting);
  const conflictPath = path.join(conflictDirectory, 'conflict-catalog.json');
  writeFileSync(conflictPath, `${JSON.stringify(conflictCatalog)}\n`, {
    mode: 0o600,
  });

  test('same-version complete-contract conflicts are unqualified and merge order independent', () => {
    const catalog = JSON.parse(readFileSync(CONTRACT_CATALOG, 'utf8'));
    const baseValue = {
      ...catalog,
      capabilities: [catalog.capabilities[1]],
    };
    const vectors = {
      input: (contract) => {
        contract.inputs[0].description = 'Different explicit bounded input.';
      },
      permission: (contract) => {
        contract.permissions[0].access = 'none';
      },
      failure: (contract) => {
        contract.failures[0].behavior = 'Return a different closed failure.';
      },
      limitation: (contract) => {
        contract.limitations[0] = 'A different operational limitation.';
      },
    };

    for (const [label, mutate] of Object.entries(vectors)) {
      const changedValue = structuredClone(baseValue);
      mutate(changedValue.capabilities[0].behavioralContract);
      const first = parseCapabilityCatalog(baseValue, {
        sourceId: 'source-000000000001',
        sourceDigest: `sha256:${'1'.repeat(64)}`,
      });
      const second = parseCapabilityCatalog(changedValue, {
        sourceId: 'source-000000000002',
        sourceDigest: `sha256:${'2'.repeat(64)}`,
      });
      const forward = mergeCapabilityCatalogs([first, second]);
      const reverse = mergeCapabilityCatalogs([second, first]);
      assert.deepEqual(reverse, forward, `${label} conflict depended on source order`);
      assert.equal(forward.length, 1);
      assert.equal(forward[0].contractQualified, false);
      assert.equal(forward[0].contractConflict, true);
      assert.equal(forward[0].contractVersion, null);
      assert.equal(forward[0].contractDigest, null);
      assert.equal(forward[0].contractVariants.length, 2);

      const [match] = matchCapabilities(
        'review-workflow',
        forward,
        [],
        { requireBehavioralContract: true },
      );
      assert.equal(match.match, 'possible-overlap');
      assert.equal(match.contractQualified, false);
      assert.equal(match.contractConflict, true);
      assert.equal(match.contractVersion, null);
      assert.equal(match.contractDigest, null);
      assert.match(match.reason, /conflict/i);
    }

    const duplicate = parseCapabilityCatalog(structuredClone(baseValue), {
      sourceId: 'source-000000000003',
      sourceDigest: `sha256:${'3'.repeat(64)}`,
    });
    const identical = mergeCapabilityCatalogs([
      parseCapabilityCatalog(baseValue, {
        sourceId: 'source-000000000001',
        sourceDigest: `sha256:${'1'.repeat(64)}`,
      }),
      duplicate,
    ]);
    assert.equal(identical[0].contractQualified, true);
    assert.equal(identical[0].contractConflict, false);
    assert.match(identical[0].contractDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(identical[0].contractVariants.length, 1);
  });
  const conflictInputs = fixtureInputs(conflictDirectory);
  const conflictReport = runV3({
    directory: conflictDirectory,
    inputs: conflictInputs,
    catalog: conflictPath,
  }).report;
  const conflictReview = conflictReport.candidates.find(
    ({ patternType }) => patternType === 'review-workflow',
  );
  assert.ok(conflictReview);
  assert.notEqual(conflictReview.classification, 'reuse-existing');
  assert.ok(
    conflictReview.capabilityMatches.some(
      ({ contractQualified, match }) =>
        contractQualified === false && match === 'possible-overlap',
    ),
  );
});

test('acceptance 8: generic failure, build, review, and repetition controls never become setup candidates', () => {
  const directory = workspace('negative-controls');
  const input = path.join(directory, 'controls.jsonl');
  const controls = [
    row('control-a', '2026-08-01T10:00:00Z', 'Fix this repeated build failure again.'),
    row('control-b', '2026-08-02T10:00:00Z', 'Repair the recurring build failure again.'),
    row('control-c', '2026-08-03T10:00:00Z', 'Fix the build failure that keeps repeating.'),
    row('control-d', '2026-08-04T10:00:00Z', 'Review this repeated failure again.'),
  ];
  writeFileSync(
    input,
    `${controls.map((value) => JSON.stringify(value)).join('\n')}\n`,
    { mode: 0o600 },
  );
  const { report } = runV3({ directory, inputs: [input], catalog: null });
  for (const candidate of repairCandidates(report)) {
    assert.equal(candidate.controlProfile.setupCandidate, false);
    assert.notEqual(candidate.facet, 'environment-bootstrap');
    assert.ok(candidate.promotion.blockers.includes('generic-control'));
  }
});

test('acceptance 9: split friction is a disjoint union and never exceeds original bounds', () => {
  const { report } = runV3();
  const split = report.detector.splitFriction;
  assert.equal(split.method, 'disjoint-capped-active-interval-union-v1');
  assert.equal(split.overlapSeconds, 0);
  assert.equal(split.withinOriginalBounds, true);
  assert.ok(split.union.lowerSeconds <= split.original.lowerSeconds);
  assert.ok(split.union.upperSeconds <= split.original.upperSeconds);
  assert.equal(split.union.lowerSeconds, split.original.lowerSeconds);
  assert.equal(split.union.upperSeconds, split.original.upperSeconds);
});

test('acceptance 10: v3 and its sidecar remain private, local, read-only, and mode 0600', () => {
  const directory = workspace('privacy');
  chmodSync(directory, 0o777);
  const inputs = fixtureInputs(directory);
  const before = inputs.map((input) =>
    createHash('sha256').update(readFileSync(input)).digest('hex'));
  const { bytes, sidecarPath } = runV3({
    directory,
    inputs,
    sidecar: true,
  });
  assert.equal(statSync(sidecarPath).mode & 0o777, 0o600);
  assert.deepEqual(
    inputs.map((input) =>
      createHash('sha256').update(readFileSync(input)).digest('hex')),
    before,
  );
  const combined = `${bytes}\n${readFileSync(sidecarPath, 'utf8')}`;
  assert.doesNotMatch(combined, /(?:^|["'\s])\/(?:Users|home|private|var|tmp)\//);
  assert.doesNotMatch(combined, /https?:\/\//i);
  assert.doesNotMatch(combined, /dep-a|review-a|generic-a/);
  assert.equal(existsSync(path.join(directory, 'sentinel')), false);
});

test('v3 limits and deterministic replay are explicit and byte stable', () => {
  const directory = workspace('replay');
  const inputs = fixtureInputs(directory);
  const first = runV3({ directory, inputs }).bytes;
  const second = runV3({ directory, inputs }).bytes;
  assert.equal(second, first);
  const excessive = ['observe', '--input', 'history.jsonl'];
  for (let index = 0; index < 17; index += 1) {
    excessive.push('--capability-catalog', `catalog-${index}.json`);
  }
  assert.throws(() => parseArgs(excessive), /exceeds its supported count/);
});

test('package exports include the v3 reader and all closed contracts', () => {
  for (const relative of [
    'scripts/rapter-clever-girl-reader.mjs',
    'scripts/rapter-clever-girl-schema-validator.mjs',
    'contracts/rapter-clever-girl-observe-v2.json',
    'contracts/rapter-clever-girl-observe-v3.json',
    'contracts/rapter-clever-girl-capability-catalog-v2.json',
    'contracts/rapter-clever-girl-repair-assignments-v1.json',
  ]) {
    assert.equal(existsSync(path.join(REPO_ROOT, relative)), true);
  }
});

test('the reader preserves v2 semantics while accepting v3 and rejecting contract mutation', () => {
  assert.deepEqual(supportedObserveReportVersions(), [
    'rapter-clever-girl.observe.v2',
    'rapter-clever-girl.observe.v3',
  ]);
  const directory = workspace('reader');
  const inputs = fixtureInputs(directory);
  const v2 = runV3({
    directory,
    inputs,
    reportVersion: '2',
  }).report;
  const v3 = runV3({ directory, inputs }).report;
  assert.equal(readObserveReport(JSON.stringify(v2)).version, '2');
  assert.equal(readObserveReport(v3).version, '3');
  assert.equal(v2.schemaVersion, 'rapter-clever-girl.observe.v2');
  assert.equal(v2.replay.analyzerVersion, '2');
  const mutated = structuredClone(v3);
  mutated.detector.unassignedRepairOccurrences = 1;
  assert.throws(
    () => readObserveReport(mutated),
    (error) =>
      error instanceof ObserveReportReaderError &&
      error.code === 'OBSERVE_REPORT_V3_ASSIGNMENT_GAP',
  );
});

test('the reader enforces every closed v2 and v3 schema boundary', () => {
  const directory = workspace('reader-closed-schema');
  const inputs = fixtureInputs(directory);
  const v2 = runV3({
    directory,
    inputs,
    reportVersion: '2',
  }).report;
  const v3 = runV3({ directory, inputs }).report;
  assert.equal(readObserveReport(v2).version, '2');
  assert.equal(readObserveReport(JSON.stringify(v3)).version, '3');

  const mutations = [
    {
      label: 'minimal invalid report',
      value: {
        schemaVersion: 'rapter-clever-girl.observe.v3',
        mode: 'observe',
      },
    },
    {
      label: 'additional top-level property',
      value: { ...structuredClone(v3), unexpected: true },
    },
    {
      label: 'empty sources below minItems',
      value: { ...structuredClone(v3), sources: [] },
    },
    {
      label: 'malformed nested candidate enum',
      value: (() => {
        const changed = structuredClone(v3);
        changed.candidates[0].promotion.blockers = ['not-a-closed-blocker'];
        return changed;
      })(),
    },
    {
      label: 'malformed nested context constant',
      value: (() => {
        const changed = structuredClone(v3);
        changed.context.behavioralCapabilityContracts.requirement = 'other';
        return changed;
      })(),
    },
    {
      label: 'additional nested context property',
      value: (() => {
        const changed = structuredClone(v3);
        changed.context.behavioralCapabilityContracts.extra = 1;
        return changed;
      })(),
    },
    {
      label: 'malformed nested source pattern',
      value: (() => {
        const changed = structuredClone(v2);
        changed.sources[0].sourceId = 'source-invalid';
        return changed;
      })(),
    },
  ];
  for (const { label, value } of mutations) {
    assert.throws(
      () => readObserveReport(value),
      (error) =>
        error instanceof ObserveReportReaderError &&
        error.code === 'OBSERVE_REPORT_INVALID',
      label,
    );
  }
});

test('auto emission selects v3 only when facet or capability-contract evidence exists', () => {
  const directory = workspace('auto');
  const inputs = fixtureInputs(directory);
  const v3 = runV3({
    directory,
    inputs,
    reportVersion: 'auto',
  }).report;
  assert.equal(v3.schemaVersion, 'rapter-clever-girl.observe.v3');

  const controls = path.join(directory, 'controls-only.jsonl');
  writeFileSync(
    controls,
    `${JSON.stringify(
      row('control', '2026-08-05T10:00:00Z', 'Inspect documentation.'),
    )}\n`,
    { mode: 0o600 },
  );
  const v2 = runV3({
    directory,
    inputs: [controls],
    catalog: null,
    reportVersion: 'auto',
  }).report;
  assert.equal(v2.schemaVersion, 'rapter-clever-girl.observe.v2');
});

test('unflagged repair output is byte-identical v2 and auto selection is opt-in', () => {
  const directory = workspace('default-v2');
  const inputs = fixtureInputs(directory);
  const unflagged = runV3({
    directory,
    inputs,
    reportVersion: null,
  });
  const explicitV2 = runV3({
    directory,
    inputs,
    reportVersion: '2',
  });
  assert.equal(unflagged.bytes, explicitV2.bytes);
  assert.equal(
    unflagged.report.schemaVersion,
    'rapter-clever-girl.observe.v2',
  );

  const automatic = runV3({
    directory,
    inputs,
    reportVersion: 'auto',
  });
  assert.equal(
    automatic.report.schemaVersion,
    'rapter-clever-girl.observe.v3',
  );
});
