#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAcceptanceReport, REQUIRED_ACCEPTANCE } from '../packages/release/src/acceptance.mjs';
import { invariant } from '../packages/release/src/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const output = path.join(root, 'packages/release/dist/acceptance');
  await mkdir(output, { recursive: true, mode: 0o700 });
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tests/tsconfig.json', '--pretty', 'false'], { cwd: root, stdio: 'inherit' });
  const nodeOutput = execFileSync(process.execPath, [
    '--test', '--test-reporter=tap',
    'tests/acceptance/release-artifacts.test.mjs', 'tests/macos-arm64/atomic-replacement.test.mjs', 'tests/macos-arm64/dmg.test.mjs',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(nodeOutput);
  invariant(/^# skipped 0$/mu.test(nodeOutput) && /^# todo 0$/mu.test(nodeOutput), 'Skipped acceptance is not a pass');
  const runtimeReport = path.join(output, 'runtime.json');
  execFileSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', '--config', 'tests/vitest.config.ts',
    '--reporter=json', '--outputFile', runtimeReport,
  ], { cwd: root, stdio: 'inherit' });
  const runtime = JSON.parse(await readFile(runtimeReport, 'utf8'));
  invariant(runtime.success === true && runtime.numPendingTests === 0 && (runtime.numTodoTests ?? 0) === 0, 'Runtime acceptance must execute and pass without skips');
  const passed = new Set(runtime.testResults.flatMap(suite => suite.assertionResults.filter(test => test.status === 'passed').map(test => test.title)));
  for (const id of REQUIRED_ACCEPTANCE) {
    if (new RegExp(`^ok \\d+ - ${id}$`, 'mu').test(nodeOutput)) passed.add(id);
  }
  const report = { schema: 'rapp-work.acceptance-report/1', results: REQUIRED_ACCEPTANCE.filter(id => passed.has(id)).map(id => ({ id, status: 'passed' })) };
  const result = assertAcceptanceReport(report);
  await writeFile(path.join(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(result));
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  console.error(error.message);
  process.exitCode = 1;
}
