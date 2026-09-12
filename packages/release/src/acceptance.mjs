import { exactKeys, invariant, readContract } from './common.mjs';

export const REQUIRED_ACCEPTANCE = Object.freeze(readContract('acceptance.json').required);

export function assertAcceptanceReport(report) {
  exactKeys(report, ['schema', 'results'], 'Acceptance report');
  invariant(report.schema === 'rapp-work.acceptance-report/1' && Array.isArray(report.results), 'Invalid acceptance report');
  const results = new Map();
  for (const result of report.results) {
    exactKeys(result, ['id', 'status'], 'Acceptance result');
    invariant(!results.has(result.id), 'Duplicate acceptance result');
    invariant(result.status === 'passed', `Acceptance did not pass: ${result.id}`);
    results.set(result.id, result.status);
  }
  for (const required of REQUIRED_ACCEPTANCE) invariant(results.get(required) === 'passed', `Required acceptance was not executed: ${required}`);
  return { status: 'passed', required: REQUIRED_ACCEPTANCE.length };
}
