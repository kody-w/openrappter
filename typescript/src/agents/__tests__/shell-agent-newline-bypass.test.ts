import { describe, it, expect } from 'vitest';

import { ShellAgent } from '../ShellAgent.js';
import { ExecSafety } from '../../security/exec-safety.js';

/**
 * The exec safety policy checked one string and ran another.
 *
 * `ShellAgent` did this:
 *
 *     const normalized = execSafety.normalizeCommand(command);
 *     const safety = execSafety.checkCommand(normalized);
 *     …
 *     await execAsync(command, …)          // ← the raw input
 *
 * `normalizeCommand` collapses all whitespace, and that includes newlines. So
 * `INJECTION_PATTERNS`, which has a rule specifically for `[\r\n]`, never saw
 * the newline: the policy judged the flattened single line, found it safe, and
 * then executed the original with the newline still in it — two commands,
 * neither approved.
 *
 *     checkCommand("ls\ntouch /tmp/x")  -> { safe: false, newline-injection }
 *     checkCommand("ls touch /tmp/x")   -> { safe: true }
 *
 * Both runtimes had it. `shell_agent.py` is also the one file exempted from
 * the no-shell-command-building guard, on the grounds that exec safety gates
 * it — an exemption that only holds while the gate cannot be stepped around.
 */

describe('ShellAgent runs only what the safety policy checked', () => {
  it('refuses a command containing a newline', async () => {
    const agent = new ShellAgent(new ExecSafety());
    const raw = JSON.parse(
      await agent.perform({ command: 'ls\ntouch /tmp/exec-safety-bypass-proof' }),
    );

    expect(raw.status).toBe('error');
    expect(raw.blocked).toBe(true);
    expect(raw.message).toMatch(/newline-injection/);
    // And it must not have been turned into an approval request either: a
    // reviewer would have been shown the flattened line, not what would run.
    expect(raw.approval_required).toBeUndefined();
  });

  it('refuses a carriage return just as readily', async () => {
    const agent = new ShellAgent(new ExecSafety());
    const result = JSON.parse(await agent.perform({ command: 'ls\rtouch /tmp/x' }));
    expect(result.blocked).toBe(true);
  });

  it('documents why the two spellings disagreed', () => {
    // Pins the premise rather than asserting it in prose. If normalization
    // ever stops swallowing newlines, this fails and the guard above can go.
    const safety = new ExecSafety();
    const raw = 'ls\ntouch /tmp/x';
    expect(safety.checkCommand(raw).safe).toBe(false);
    expect(safety.checkCommand(safety.normalizeCommand(raw)).safe).toBe(true);
  });

  it('still runs an ordinary safe command', async () => {
    // Anti-vacuity: a guard that blocked everything would pass the tests above.
    const agent = new ShellAgent(new ExecSafety());
    const result = JSON.parse(await agent.perform({ command: 'echo hello' }));
    expect(result.status).toBe('success');
    expect(String(result.output)).toContain('hello');
  });
});
