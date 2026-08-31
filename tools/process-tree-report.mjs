#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const [reportPath, runner] = process.argv.slice(2);
if (!reportPath || !['Linux', 'Windows'].includes(runner)) {
  console.error('usage: node tools/process-tree-report.mjs <vitest-json> <Linux|Windows>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const suites = (report.testResults ?? []).filter((suite) =>
  String(suite.name ?? '').replaceAll('\\', '/').endsWith('/src/infra/process-tree.test.ts'));
if (suites.length !== 1) {
  throw new Error(`Expected one process-tree test result, found ${suites.length}.`);
}

const assertions = suites[0].assertionResults ?? [];
const failed = assertions.filter((assertion) => assertion.status === 'failed');
if (failed.length > 0) {
  throw new Error(`Process-tree report contains ${failed.length} failed assertion(s).`);
}

const windows = assertions.filter((assertion) =>
  String(assertion.fullName ?? assertion.title ?? '').startsWith('Windows Job Object integration '));
if (windows.length !== 2) {
  throw new Error(`Expected exactly two Windows Job Object assertions, found ${windows.length}.`);
}

const skipped = assertions.filter((assertion) =>
  assertion.status === 'pending' || assertion.status === 'skipped');
if (runner === 'Linux') {
  if (skipped.length !== 2 || !windows.every((assertion) =>
    assertion.status === 'pending' || assertion.status === 'skipped')) {
    throw new Error(
      `Linux must skip exactly the two Windows Job Object assertions; observed ${skipped.length} skip(s).`,
    );
  }
} else {
  const windowsSkipped = windows.filter((assertion) =>
    assertion.status === 'pending' || assertion.status === 'skipped');
  const windowsPassed = windows.filter((assertion) => assertion.status === 'passed');
  if (windowsSkipped.length !== 0 || windowsPassed.length !== 2) {
    throw new Error(
      `Windows must execute both Job Object assertions: ${windowsPassed.length} passed, ${windowsSkipped.length} skipped.`,
    );
  }
}

console.log(JSON.stringify({
  runner,
  total: assertions.length,
  passed: assertions.filter((assertion) => assertion.status === 'passed').length,
  skipped: skipped.length,
  windowsJobObjectPassed: windows.filter((assertion) => assertion.status === 'passed').length,
  windowsJobObjectSkipped: windows.filter((assertion) =>
    assertion.status === 'pending' || assertion.status === 'skipped').length,
}));
