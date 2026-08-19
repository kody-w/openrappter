/**
 * `openrappter audit --fail-on <severity>`: the number it prints and the exit
 * code it sets must describe the same threshold.
 *
 * They did not. The exit code came from `--fail-on`, but the summary line
 * counted against a hardcoded `Set(['critical','high'])` and was worded
 * "N at high or critical". So with a single `high` finding on the machine:
 *
 *     $ openrappter audit --fail-on critical
 *       1 finding, 1 at high or critical.      <- reads as blocking
 *       $? = 0                                  <- but it passed
 *
 * and in the other direction `--fail-on low` reported "0 at high or critical"
 * while exiting 1 -- a CI gate that fails while printing a reassuring zero.
 *
 * The count is the only thing that tells a human *why* the command exited the
 * way it did, so it is tested against the exit code rather than on its own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import type { AuditFinding } from '../../security/audit.js';

const findings = vi.hoisted(() => ({ current: [] as AuditFinding[] }));

vi.mock('../../security/audit.js', () => ({
  SecurityAuditor: class {
    async runAll(): Promise<AuditFinding[]> {
      return findings.current;
    }
  },
}));

function finding(severity: AuditFinding['severity']): AuditFinding {
  return {
    checkId: `check-${severity}`,
    severity,
    title: `A ${severity} problem`,
    detail: 'planted by the test',
  } as AuditFinding;
}

async function runAudit(argv: string[]): Promise<{ out: string; code: number }> {
  const { registerAuditCommand } = await import('../../cli/audit.js');
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a) => {
    lines.push(a.join(' '));
  });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const saved = process.exitCode;
  process.exitCode = 0;

  const program = new Command();
  program.exitOverride();
  registerAuditCommand(program);
  await program.parseAsync(['node', 'openrappter', 'audit', ...argv]);

  const code = Number(process.exitCode ?? 0);
  process.exitCode = saved;
  log.mockRestore();
  err.mockRestore();
  return { out: lines.join('\n'), code };
}

/** The count the summary line reports as blocking. */
function reportedBlocking(out: string): number {
  const m = /(\d+) at or above/.exec(out);
  expect(m, `summary should report a blocking count, got:\n${out}`).toBeTruthy();
  return Number(m![1]);
}

afterEach(() => {
  findings.current = [];
  vi.restoreAllMocks();
});

describe('audit --fail-on: the printed count and the exit code agree', () => {
  const levels = ['critical', 'high', 'medium', 'low', 'info'] as const;

  for (const planted of levels) {
    for (const threshold of levels) {
      it(`a ${planted} finding under --fail-on ${threshold}`, async () => {
        findings.current = [finding(planted)];
        const { out, code } = await runAudit(['--fail-on', threshold]);

        const blocking = reportedBlocking(out);
        // Whenever the summary claims something is blocking, the command must
        // have exited non-zero -- and vice versa. This is the invariant the
        // hardcoded set broke.
        expect(blocking > 0).toBe(code === 1);
      });
    }
  }

  it('names the threshold the user asked for, not a fixed one', async () => {
    findings.current = [finding('low')];
    const { out } = await runAudit(['--fail-on', 'low']);
    expect(out).toContain('at or above low');
  });

  it('counts every finding at or above the threshold', async () => {
    findings.current = [
      finding('critical'),
      finding('high'),
      finding('low'),
      finding('info'),
    ];
    const { out, code } = await runAudit(['--fail-on', 'low']);
    expect(reportedBlocking(out)).toBe(3);
    expect(code).toBe(1);
  });

  it('still rejects a threshold that is not a severity', async () => {
    findings.current = [finding('critical')];
    const { code } = await runAudit(['--fail-on', 'catastrophic']);
    expect(code).toBe(1);
  });
});
