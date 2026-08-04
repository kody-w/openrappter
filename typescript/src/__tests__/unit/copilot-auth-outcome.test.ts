/**
 * The daemon used to print one line for three different failures:
 *
 *   🦖 Cached GitHub token rejected by Copilot API — re-authenticating…
 *   🦖 No GitHub token found. Run 'openrappter onboard' to set up Copilot.
 *
 * Those two lines are adjacent in a real log from this machine, and they
 * contradict each other: a token was found, and then reported as absent. Under
 * launchd there is also no TTY, so the re-auth the first line promises never
 * runs — which is why the second line appears at all.
 */
import { describe, it, expect } from 'vitest';
import { describeCopilotAuth } from '../../index.js';
import type { CopilotAuthOutcome } from '../../copilot-check.js';

const lines = (o: CopilotAuthOutcome) => describeCopilotAuth(o).join('\n');

describe('describeCopilotAuth', () => {
  it('does not claim a token is missing when one was found and rejected', () => {
    const text = lines({ status: 'rejected', interactive: false });
    expect(text).not.toMatch(/No GitHub token found/);
    expect(text).toMatch(/rejected it/);
  });

  it('says a rejected token is stale or unentitled, which is the actionable part', () => {
    expect(lines({ status: 'rejected', interactive: false })).toMatch(/stale or lacks Copilot access/);
  });

  it('still reports a genuinely absent token as absent', () => {
    const text = lines({ status: 'missing', interactive: false });
    expect(text).toMatch(/No GitHub token found/);
    expect(text).not.toMatch(/rejected/);
  });

  it('tells a non-interactive process where onboard has to be run', () => {
    for (const outcome of [
      { status: 'rejected', interactive: false },
      { status: 'missing', interactive: false },
    ] as CopilotAuthOutcome[]) {
      expect(lines(outcome)).toMatch(/no terminal/);
      expect(lines(outcome)).toMatch(/in a shell/);
    }
  });

  it('distinguishes the two failures from each other', () => {
    expect(lines({ status: 'rejected', interactive: false }))
      .not.toBe(lines({ status: 'missing', interactive: false }));
  });

  it('surfaces the underlying error when interactive auth failed', () => {
    expect(lines({ status: 'failed', error: 'device flow timed out' }))
      .toMatch(/device flow timed out/);
  });

  it('names how a successful token was obtained', () => {
    expect(lines({ status: 'authenticated', token: 'ghu_x', source: 'cache' })).toMatch(/cache/);
    expect(lines({ status: 'authenticated', token: 'ghu_x', source: 'device-code' })).toMatch(/device-code/);
  });

  it('never leaks the token into operator output', () => {
    expect(lines({ status: 'authenticated', token: 'ghu_supersecret', source: 'cache' }))
      .not.toMatch(/ghu_supersecret/);
  });
});
