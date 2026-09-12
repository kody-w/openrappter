import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { checkReleaseConstitution } from '../../../scripts/check-release-constitution.mjs';
import { assertAcceptanceReport, REQUIRED_ACCEPTANCE } from '../src/acceptance.mjs';
import { commitFixture, put, sourceFixture } from './helpers.mjs';

test('acceptance reports cannot turn skipped, empty or duplicate results into a pass', () => {
  const report = { schema: 'rapp-work.acceptance-report/1', results: REQUIRED_ACCEPTANCE.map(id => ({ id, status: 'passed' })) };
  assert.equal(assertAcceptanceReport(report).required, 9);
  assert.throws(() => assertAcceptanceReport({ ...report, results: [] }), /not executed/u);
  assert.throws(() => assertAcceptanceReport({ ...report, results: [...report.results, report.results[0]] }), /Duplicate/u);
  assert.throws(() => assertAcceptanceReport({ ...report, results: [{ id: REQUIRED_ACCEPTANCE[0], status: 'skipped' }] }), /did not pass/u);
});

test('Release Constitution accepts only the exact clean source, complete locked workspace and workflow set', async t => {
  const root = await sourceFixture(t);
  for (const relative of [
    '.github/workflows/ci.yml', '.github/workflows/release-macos.yml', '.github/workflows/release-constitution-check.yml',
    'tests/acceptance/runtime.test.ts', 'tests/acceptance/release-artifacts.test.mjs',
    'tests/macos-arm64/atomic-replacement.test.mjs', 'tests/macos-arm64/dmg.test.mjs',
  ]) {
    await put(root, relative, await readFile(new URL(`../../../${relative}`, import.meta.url)));
  }
  commitFixture(root);
  const result = await checkReleaseConstitution(root);
  assert.equal(result.status, 'passed');
  assert.equal(result.workspaces, 14);
  await put(root, '.github/workflows/unexpected.yml', 'name: Unexpected\n');
  commitFixture(root);
  await assert.rejects(checkReleaseConstitution(root), /three clean workflows/u);
  await rm(path.join(root, '.github/workflows/unexpected.yml'));
  await mkdir(path.join(root, 'packages/extra'));
  await put(root, 'packages/extra/package.json', { name: '@rapp-work/extra', version: '2.0.0' });
  await assert.rejects(checkReleaseConstitution(root), /Unallowlisted workspace/u);
});
