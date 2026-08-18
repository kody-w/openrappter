#!/usr/bin/env node
/**
 * A skipped test is indistinguishable from a passing one in the summary line.
 *
 *     Test Files  284 passed | 3 skipped (287)
 *     Tests       4795 passed | 21 skipped (4816)
 *
 * Nothing in a green run tells you that eleven telephony integration tests
 * covering call negotiation, approval timeouts, the audit chain and concurrent
 * writers had never executed in any environment — they resolved a binary CI
 * installed in two other workflows but not in the job that runs the suite
 * (#280). The install fixed it; only this stops it recurring silently, and
 * catches the next file that starts skipping for its own reason.
 *
 * Every skip must be named here with a reason. Anything else fails the build.
 *
 * Usage: node tools/skip-budget.mjs <vitest-json-report>
 */

import { readFileSync } from 'node:fs';

/**
 * Files permitted to skip, and how many.
 *
 * A budget is a claim that the tests run *somewhere*. If that somewhere stops
 * being true, the entry is wrong and should be deleted along with the tests.
 */
const ALLOWED = {
  'src/flight-recorder/windows-storage.test.ts': {
    max: 2,
    why: 'Windows-only storage paths. flight-recorder.yml and release.yml run '
      + 'this file explicitly on windows-latest, so it is exercised — just not '
      + 'on this runner.',
  },
  'src/telephony/providers/google-voice-live.test.ts': {
    max: 3,
    why: 'Drives a real Chrome over a CDP port set by OPENRAPPTER_CDP_PORT. '
      + 'No CI job provides one, so these are manual by design.',
  },
};

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('usage: node tools/skip-budget.mjs <vitest-json-report>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const skippedByFile = new Map();
for (const suite of report.testResults ?? []) {
  const file = String(suite.name ?? '').replace(/.*\/typescript\//, '');
  for (const assertion of suite.assertionResults ?? []) {
    if (assertion.status === 'pending' || assertion.status === 'skipped') {
      if (!skippedByFile.has(file)) skippedByFile.set(file, []);
      skippedByFile.get(file).push(assertion.fullName ?? assertion.title ?? '?');
    }
  }
}

// Anti-vacuity: a report this script cannot read would produce an empty map
// and pass, which is the exact failure it exists to prevent.
const total = report.numTotalTests ?? 0;
if (total < 1000) {
  console.error(
    `::error::skip budget read only ${total} tests from ${reportPath}; `
    + 'that is not the full suite, so its verdict means nothing',
  );
  process.exit(1);
}

let failed = false;

for (const [file, names] of [...skippedByFile].sort()) {
  const entry = ALLOWED[file];
  if (!entry) {
    console.error(`::error::${file} skipped ${names.length} test(s) with no budget entry.`);
    console.error('  A skip is not a pass. Either make them run, or add an entry to');
    console.error('  tools/skip-budget.mjs saying where they do run and why.');
    for (const n of names.slice(0, 5)) console.error(`    - ${n}`);
    failed = true;
    continue;
  }
  if (names.length > entry.max) {
    console.error(
      `::error::${file} skipped ${names.length} test(s), budget is ${entry.max}.`,
    );
    console.error(`  Budget reason: ${entry.why}`);
    failed = true;
  }
}

// A budget for a file that no longer skips is stale. Report it rather than let
// the list rot into a set of claims nobody checks.
for (const [file, entry] of Object.entries(ALLOWED)) {
  if (!skippedByFile.has(file)) {
    console.log(`note: ${file} no longer skips anything; its budget entry can go.`);
    void entry;
  }
}

if (failed) process.exit(1);

const skippedTotal = [...skippedByFile.values()].reduce((n, l) => n + l.length, 0);
console.log(
  `skip budget satisfied: ${skippedTotal} skipped, all accounted for, `
  + `${report.numPassedTests}/${total} passed`,
);
