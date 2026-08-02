/**
 * The daemon must still find the Copilot CLI when nobody started it from a shell.
 *
 * Scope note: error *content* is covered by the surgeon commit's own classifier
 * tests in `../copilot-cli-direct.test.ts`. What is asserted here is the part
 * that fix did not address — locating the CLI at all.
 *
 * The defect these cover, reproduced exactly before the fix:
 *
 *     Command failed: …/github.copilot-chat/copilotCli/copilot -p <identity>…
 *     stderr: Cannot find GitHub Copilot CLI
 *     stdout: Install GitHub Copilot CLI? ['y/N']
 *     …after 23.5s
 *
 * Three separate faults produced that one red box:
 *
 *  1. `findCLI()` preferred the VS Code entry, which is not the CLI — it is a
 *     300-byte shim that shells `copilot --version` to find the real binary. So
 *     it only works when the real CLI is *also* on PATH.
 *  2. A menu-bar app launched from Finder inherits launchd's PATH
 *     (`/usr/bin:/bin:/usr/sbin:/sbin`), and `ProcessManager` spawns the daemon
 *     without setting `environment`, so `/opt/homebrew/bin` was unreachable.
 *  3. `execFile` leaves stdin open, so the shim's `['y/N']` prompt blocked until
 *     the timeout instead of failing fast.
 *
 * And the message printed the entire argv — leaking the system prompt into the
 * UI while burying the stderr that actually explained the problem.
 */

import { describe, expect, it } from 'vitest';
import { CopilotCliDirectProvider, resolveSpawnPath } from '../copilot-cli-direct.js';

describe('resolveSpawnPath', () => {
  it('adds Homebrew when the inherited PATH is launchd-thin', () => {
    const p = resolveSpawnPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/x' });
    expect(p.split(':')).toContain('/opt/homebrew/bin');
    expect(p.split(':')).toContain('/usr/local/bin');
  });

  it('keeps the operator PATH ahead of the fallbacks', () => {
    const p = resolveSpawnPath({ PATH: '/my/tools', HOME: '/Users/x' }).split(':');
    expect(p[0]).toBe('/my/tools');
  });

  it('never repeats a directory', () => {
    const p = resolveSpawnPath({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x' }).split(':');
    expect(p.filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
  });

  it('survives an entirely absent PATH', () => {
    const p = resolveSpawnPath({ HOME: '/Users/x' });
    expect(p.split(':')).toContain('/opt/homebrew/bin');
    expect(p.split(':')).toContain('/bin');
  });
});

describe('findCLI ordering', () => {
  it('ranks every real install above the VS Code shim', () => {
    // Asserted on the ordering itself, not on whatever this machine happens to
    // have installed. The first version of this test compared findCLI()'s
    // result against paths it could never equal, so it passed even with the
    // broken order restored — a guard that cannot fail is not a guard.
    const order = CopilotCliDirectProvider.candidatePaths('/Users/x');
    const shim = order.findIndex((p) => p.includes('github.copilot-chat'));
    expect(shim, 'the VS Code shim must be present as a fallback').toBeGreaterThan(-1);
    expect(shim, 'the shim must be last — it depends on the real CLI being on PATH')
      .toBe(order.length - 1);
    expect(order[0]).toBe('/opt/homebrew/bin/copilot');
  });

  it('honours an explicit override first', () => {
    const prev = process.env.OPENRAPPTER_COPILOT_CLI;
    process.env.OPENRAPPTER_COPILOT_CLI = '/bin/sh'; // exists, so it should win
    try {
      expect(CopilotCliDirectProvider.findCLI()).toBe('/bin/sh');
    } finally {
      if (prev === undefined) delete process.env.OPENRAPPTER_COPILOT_CLI;
      else process.env.OPENRAPPTER_COPILOT_CLI = prev;
    }
  });
});
