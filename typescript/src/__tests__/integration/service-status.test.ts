/**
 * `service status` exists because launchd and the running gateway can disagree
 * permanently, and nothing said so.
 *
 * On the machine that prompted #144 they had disagreed for thirteen days:
 *
 *     launchctl list   ->  -   1   com.openrappter.gateway   (no pid, exit 1)
 *     curl /health     ->  200
 *     launchctl print  ->  runs = 29
 *
 * A gateway started outside launchd held the port, so all 29 supervised starts
 * exited 1 with `EADDRINUSE`. Every signal available said "fine": health
 * answered, and `doctor` reported the same "port is in use (gateway may
 * already be running)" that it reports when supervision is correct.
 *
 * These tests drive the pure functions rather than `launchctl`, so they assert
 * the *diagnosis* rather than the state of whatever machine runs them.
 */
import { describe, it, expect } from 'vitest';
import { parseLaunchctlRow, describeSupervision, type ServiceStatus } from '../../cli/service-status.js';

const LABEL = 'com.openrappter.gateway';

/** A `launchctl list` sample in the real tab-separated shape. */
const LISTING = [
  'PID\tStatus\tLabel',
  '53830\t-15\tcom.openrappter.keepawake',
  '-\t1\tcom.openrappter.gateway',
  '22988\t0\tcom.rapp.infrastructure-city',
].join('\n');

function status(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    installed: true,
    loaded: true,
    running: false,
    supervisedPid: null,
    supervisor: 'user',
    live: false,
    ready: false,
    servingPid: null,
    servedByForeignProcess: false,
    lastExit: null,
    ...overrides,
  } as ServiceStatus;
}

describe('parseLaunchctlRow', () => {
  it('reads the failed job the way launchctl prints it', () => {
    expect(parseLaunchctlRow(LISTING, LABEL)).toEqual({
      registered: true,
      pid: null,
      lastExit: 1,
    });
  });

  it('reads a healthy job', () => {
    expect(parseLaunchctlRow('4242\t0\tcom.openrappter.gateway', LABEL)).toEqual({
      registered: true,
      pid: 4242,
      lastExit: 0,
    });
  });

  it('does not match a label that merely contains the name', () => {
    expect(parseLaunchctlRow('99\t0\tcom.openrappter.gateway.helper', LABEL).registered).toBe(false);
  });
});

describe('describeSupervision', () => {
  it('stays quiet when launchd owns the running gateway', () => {
    expect(
      describeSupervision(status({ running: true, supervisedPid: 4242, servingPid: 4242, live: true, lastExit: 0 })),
    ).toBeNull();
  });

  it('names the exact state from #144, using the flag that already describes it', () => {
    // `servedByForeignProcess` is computed by the supervision reader; this
    // command no longer re-derives the same condition under another name.
    const message = describeSupervision(
      status({ lastExit: 1, servingPid: 25041, live: true, servedByForeignProcess: true }),
    );
    expect(message).toContain('NOT started by launchd');
    expect(message).toContain('25041');
    expect(message).toContain('unsupervised');
    expect(message).toContain('EADDRINUSE');
  });

  it('reports a gateway running with no job installed at all', () => {
    const message = describeSupervision(
      status({ installed: false, servingPid: 900, live: true }),
    );
    expect(message).toContain('no launchd job is installed');
    expect(message).toContain('openrappter service install');
  });

  it('stays quiet when nothing is installed and nothing is running', () => {
    expect(describeSupervision(status({ installed: false }))).toBeNull();
  });

  it('reports a job that is installed but genuinely stopped', () => {
    const message = describeSupervision(status({ lastExit: 0, live: false }));
    expect(message).toContain('nothing is running');
  });

  it('catches an unsupervised gateway even when servedByForeignProcess cannot', () => {
    // The neighbouring flag compares the serving pid against the *supervised*
    // pid, so it is false when launchd owns nothing -- exactly the machine
    // state in #144, where 29 supervised starts died on EADDRINUSE behind a
    // hand-started process. Delegating to it alone lost this diagnosis, which
    // is why both readings are kept.
    const message = describeSupervision(
      status({ installed: true, running: false, live: true, servingPid: 25041, lastExit: 1, servedByForeignProcess: false }),
    );
    expect(message).toContain('NOT started by launchd');
    expect(message).toContain('EADDRINUSE');
  });
});
