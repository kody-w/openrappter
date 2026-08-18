import { describe, it, expect } from 'vitest';
import { GitAgent } from '../GitAgent.js';
import type { ExecFn } from '../GitAgent.js';

/**
 * Caller-supplied values reach `git` as arguments, never as shell syntax.
 *
 * `GitAgent` built every command by interpolating into a single string and ran
 * it through `execSync`, which uses a shell. Confirmed against the built agent:
 *
 *     execute({ action: 'log', count: '1 ; touch /tmp/openrappter-injection-proof' })
 *     -> the file was created
 *
 * `count` was not special. `name` (branch), `fileList` (add), `message`
 * (commit), and the `gh pr create` title, body and base were interpolated the
 * same way — five reachable sites, found only because migrating the first
 * exposed the rest.
 *
 * The fix is structural rather than per-field: `ExecFn` now takes a binary and
 * an argument vector, and `execFileSync` hands each element to the process as
 * one argv entry. There is no shell left to escape into, so no escaping rule
 * has to be got right.
 *
 * These tests assert on the argv the agent builds. Nothing here executes git.
 */

function capture(): { calls: { binary: string; args: string[] }[]; exec: ExecFn } {
  const calls: { binary: string; args: string[] }[] = [];
  const exec: ExecFn = (binary, args) => {
    calls.push({ binary, args });
    return { stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const PAYLOAD = '1 ; touch /tmp/openrappter-injection-proof';

describe('GitAgent passes arguments, not shell syntax', () => {
  it('keeps an injected count inside a single argument', async () => {
    const { calls, exec } = capture();
    await new GitAgent({ execFn: exec }).perform({ action: 'log', count: PAYLOAD });

    const log = calls.find((c) => c.args[0] === 'log');
    expect(log, 'the log command should have run').toBeDefined();
    // The payload may be present -- as one argv element. What must not happen
    // is it being split into further arguments, which is what a shell did.
    const suspicious = log!.args.filter((a) => a.includes('touch'));
    expect(suspicious).toHaveLength(1);
    expect(suspicious[0]).toBe(`-${PAYLOAD}`);
  });

  it('keeps an injected branch name inside a single argument', async () => {
    const { calls, exec } = capture();
    await new GitAgent({ execFn: exec }).perform({
      action: 'branch',
      create: true,
      name: 'feature; rm -rf /tmp/x',
    });

    const checkout = calls.find((c) => c.args[0] === 'checkout');
    expect(checkout?.args).toEqual(['checkout', '-b', 'feature; rm -rf /tmp/x']);
  });

  it('keeps an injected commit message inside a single argument', async () => {
    const { calls, exec } = capture();
    await new GitAgent({ execFn: exec }).perform({
      action: 'commit',
      files: ['a.ts'],
      message: 'msg" ; touch /tmp/x ; echo "',
    });

    const commit = calls.find((c) => c.args[0] === 'commit');
    expect(commit?.args).toEqual(['commit', '-m', 'msg" ; touch /tmp/x ; echo "']);
  });

  it('never hands a whole command line to the exec seam', async () => {
    // The property that makes the class impossible rather than handled: no
    // argument may contain a shell metacharacter *because the agent put it
    // there*. Each element is one argv entry, so the only metacharacters
    // present are ones the caller supplied inside a single value.
    const { calls, exec } = capture();
    const agent = new GitAgent({ execFn: exec });
    await agent.perform({ action: 'status' });
    await agent.perform({ action: 'diff' });

    for (const call of calls) {
      expect(['git', 'gh']).toContain(call.binary);
      for (const arg of call.args) {
        expect(arg, `${call.binary} ${call.args.join(' ')}`).not.toMatch(/[;&|]/);
      }
    }
  });

  it('still runs the command it is supposed to', async () => {
    // Anti-vacuity: assertions about argv prove nothing if the agent stopped
    // issuing commands.
    const { calls, exec } = capture();
    await new GitAgent({ execFn: exec }).perform({ action: 'status' });
    expect(calls).toEqual([{ binary: 'git', args: ['status', '--porcelain'] }]);
  });
});
