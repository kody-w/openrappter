/**
 * `openrappter audit` — run the security auditor and report what it found.
 *
 * `SecurityAuditor` existed with five checks and was imported by exactly one
 * file: its own test. No production path constructed it and there was no
 * command, so a security control that reports *"Gateway exposed without
 * authentication"* at critical severity had never examined anything (#246).
 *
 * Worse than dormant, it was dormant *and* looked fine: the config checks read
 * `~/.openrappter/config.yml`, a file the product does not write, and the
 * missing-file branch returns `[]` -- indistinguishable from a clean bill of
 * health.
 *
 * Exit codes are the point of having this in a terminal: `1` when anything at
 * or above `--fail-on` is found, so it can gate a script. The printed summary
 * counts against that same threshold -- an earlier version counted against a
 * fixed `critical|high` set while exiting on `--fail-on`, so the two disagreed
 * whenever the flag was not left at its default.
 */
import type { Command } from 'commander';
import { SecurityAuditor, type AuditFinding } from '../security/audit.js';

const ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function severityRank(finding: AuditFinding): number {
  return ORDER[finding.severity] ?? 99;
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('Check this installation for security problems')
    .option('--json', 'Print the raw findings')
    .option('--fail-on <severity>', 'Exit non-zero at or above this severity', 'high')
    .action(async (options: { json?: boolean; failOn?: string }) => {
      const auditor = new SecurityAuditor();
      const findings = await auditor.runAll();

      if (options.json) {
        console.log(JSON.stringify(findings, null, 2));
      }

      const threshold = ORDER[options.failOn ?? 'high'];
      if (threshold === undefined) {
        console.error(
          `\n  --fail-on must be one of: ${Object.keys(ORDER).join(', ')}\n`,
        );
        process.exitCode = 1;
        return;
      }

      if (!options.json) {
        if (findings.length === 0) {
          console.log('\n  No findings.\n');
        } else {
          for (const finding of [...findings].sort((a, b) => severityRank(a) - severityRank(b))) {
            console.log(`\n  [${finding.severity}] ${finding.title}  (${finding.checkId})`);
            console.log(`    ${finding.detail}`);
            if (finding.remediation) console.log(`    fix: ${finding.remediation}`);
          }
          const level = options.failOn ?? 'high';
          const blocking = findings.filter((f) => severityRank(f) <= threshold).length;
          console.log(
            `\n  ${findings.length} finding${findings.length === 1 ? '' : 's'}`
            + `, ${blocking} at or above ${level}.\n`,
          );
        }
      }

      if (findings.some((f) => severityRank(f) <= threshold)) {
        process.exitCode = 1;
      }
    });
}
