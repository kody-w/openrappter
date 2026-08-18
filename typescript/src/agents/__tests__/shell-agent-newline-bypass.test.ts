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

/**
 * A single `&` chains commands too.
 *
 * `INJECTION_PATTERNS` covered `&&` and not `&`, so `ls & touch /tmp/x` was
 * judged safe and both commands ran — `ls` is a safe binary, which is what
 * made the pair look unremarkable. Verified in a real shell:
 * `sh -c 'ls / >/dev/null & touch /tmp/marker'` creates the marker.
 *
 * Same shape as the newline bypass above: a separator the policy did not know
 * about, on a command whose visible binary is harmless.
 */
describe('ShellAgent treats a single ampersand as a chain', () => {
  it('blocks a background chain', async () => {
    const agent = new ShellAgent(new ExecSafety());
    const result = JSON.parse(await agent.perform({ command: 'ls & touch /tmp/amp-bypass-proof' }));
    expect(result.blocked).toBe(true);
    expect(result.message).toMatch(/background-chain/);
  });

  it('blocks a trailing ampersand', async () => {
    const safety = new ExecSafety();
    expect(safety.checkCommand('ls &').safe).toBe(false);
  });

  it('still reports && as an and-chain rather than reclassifying it', async () => {
    // The new rule must not swallow the existing one: `&&` has its own reason,
    // and a lookaround that matched it would change every existing message.
    const safety = new ExecSafety();
    const result = safety.checkCommand('ls && touch /tmp/x');
    expect(result.safe).toBe(false);
    expect(result.reason).toMatch(/and-chain/);
  });

  it('leaves ordinary commands alone', () => {
    const safety = new ExecSafety();
    for (const cmd of ['echo hello', 'ls -la', 'git status']) {
      expect(safety.checkCommand(cmd).safe, cmd).toBe(true);
    }
  });
});
