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
    registered: true,
    launchdPid: null,
    lastExit: null,
    recordedPid: null,
    recordedAlive: false,
    ...overrides,
  };
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
    // `com.openrappter.gateway.helper` is a different job.
    const other = '99\t0\tcom.openrappter.gateway.helper';
    expect(parseLaunchctlRow(other, LABEL).registered).toBe(false);
  });

  it('reports an absent job rather than guessing', () => {
    expect(parseLaunchctlRow('53830\t-15\tcom.openrappter.keepawake', LABEL)).toEqual({
      registered: false,
      pid: null,
      lastExit: null,
    });
  });
});

describe('describeSupervision', () => {
  it('stays quiet when launchd owns the running gateway', () => {
    expect(
      describeSupervision(status({ launchdPid: 4242, lastExit: 0, recordedPid: 4242, recordedAlive: true })),
    ).toBeNull();
  });

  it('names the exact state from #144', () => {
    // Registered, no supervised pid, and something else alive on the port.
    const message = describeSupervision(
      status({ lastExit: 1, recordedPid: 25041, recordedAlive: true }),
    );
    expect(message).toContain('NOT started by launchd');
    expect(message).toContain('25041');
    expect(message).toContain('unsupervised');
    // The actionable part: this is what makes every supervised start fail.
    expect(message).toContain('EADDRINUSE');
  });

  it('reports a gateway running with no job installed at all', () => {
    const message = describeSupervision(
      status({ registered: false, recordedPid: 900, recordedAlive: true }),
    );
    expect(message).toContain('no launchd job is installed');
    expect(message).toContain('openrappter service install');
  });

  it('stays quiet when nothing is installed and nothing is running', () => {
    expect(describeSupervision(status({ registered: false }))).toBeNull();
  });

  it('reports a job that is installed but genuinely stopped', () => {
    const message = describeSupervision(status({ lastExit: 0, recordedPid: 111, recordedAlive: false }));
    expect(message).toContain('nothing is running');
  });

  it('reports a supervised pid that disagrees with the recorded one', () => {
    // Two gateways: launchd owns one, another wrote the pid file. Whoever
    // reads that file is talking to a process launchd is not supervising.
    const message = describeSupervision(
      status({ launchdPid: 100, recordedPid: 200, recordedAlive: true }),
    );
    expect(message).toContain('supervises pid 100');
    expect(message).toContain('recorded pid 200');
  });
});
