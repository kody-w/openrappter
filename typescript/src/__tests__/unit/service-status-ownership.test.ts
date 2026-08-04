/**
 * `getIMessageServiceStatus()` used to report three things that were each
 * individually defensible and collectively false.
 *
 * Observed on the machine that motivated this, all at the same moment:
 *
 *   launchctl print gui/501/com.openrappter.gateway  -> exit 0
 *                                                       state = not running
 *                                                       last exit code = (never exited)
 *   ~/.openrappter/gateway.pid                       -> 44229
 *   lsof -nP -iTCP:18790 -sTCP:LISTEN                -> node 44229
 *
 * Status therefore said loaded=true (exit 0 means *registered*, not running)
 * and live=true ready=true (the port answered — from pid 44229, a process the
 * installed agent does not own). Nothing was lying on its own; the composite
 * told an operator the service was healthy when the job they installed was not
 * executing at all.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import http from 'http';
import { reserveTestPort } from '../support/test-port.js';
import {
  getIMessageServiceStatus,
  parseLaunchdPid,
  isLaunchdRunning,
  OPENRAPPTER_LAUNCH_AGENT_LABEL,
} from '../../channels/imessage-launchd.js';

const RUNNING = 'state = running\n\tpid = 44229\n\tlast exit code = 0\n';
const REGISTERED_ONLY = 'state = not running\n\tlast exit code = (never exited)\n';

async function homeWithPlist(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-status-'));
  const agents = path.join(dir, 'Library', 'LaunchAgents');
  await fs.mkdir(agents, { recursive: true });
  await fs.writeFile(path.join(agents, `${OPENRAPPTER_LAUNCH_AGENT_LABEL}.plist`), '<plist/>');
  return dir;
}

function statusWith(opts: {
  home: string;
  userPrint: { stdout: string; exitCode: number };
  lockPid: number | null;
}) {
  return getIMessageServiceStatus({
    homeDirectory: opts.home,
    checkHttp: false,
    lockOwnerReader: () => ({ pid: opts.lockPid, alive: opts.lockPid !== null }),
    commandRunner: async (_exe: string, args: readonly string[]) =>
      args[1]?.startsWith('system/')
        ? { stdout: '', exitCode: 113 }
        : opts.userPrint,
  } as never);
}

describe('launchctl output parsing', () => {
  it('reads the pid of a running job', () => {
    expect(parseLaunchdPid(RUNNING)).toBe(44229);
  });

  it('reports no pid for a job that is registered but never started', () => {
    expect(parseLaunchdPid(REGISTERED_ONLY)).toBeNull();
  });

  it('does not mistake a registered job for a running one', () => {
    expect(isLaunchdRunning(REGISTERED_ONLY)).toBe(false);
    expect(isLaunchdRunning(RUNNING)).toBe(true);
  });

  it('ignores a non-positive pid rather than trusting it', () => {
    expect(parseLaunchdPid('state = running\n\tpid = 0\n')).toBeNull();
  });
});

describe('getIMessageServiceStatus ownership', () => {

  /** Run a status check against a real listener, so `live` is genuinely true. */
  async function withLiveListener(
    lockPid: number | null,
    userPrint: { stdout: string; exitCode: number },
  ) {
    const port = await reserveTestPort();
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      const home = await homeWithPlist();
      return await getIMessageServiceStatus({
        homeDirectory: home,
        port,
        checkHttp: true,
        lockOwnerReader: () => ({ pid: lockPid, alive: lockPid !== null }),
        commandRunner: async (_exe: string, args: readonly string[]) =>
          args[1]?.startsWith('system/') ? { stdout: '', exitCode: 113 } : userPrint,
      } as never);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('separates "registered" from "running" — the exact case observed', async () => {
    const home = await homeWithPlist();
    const status = await statusWith({
      home, userPrint: { stdout: REGISTERED_ONLY, exitCode: 0 }, lockPid: 44229,
    });

    expect(status.loaded).toBe(true);   // registered, as launchd reports
    expect(status.running).toBe(false); // but not executing
    expect(status.supervisedPid).toBeNull();
  });

  it('reports the pid that actually holds the port', async () => {
    const home = await homeWithPlist();
    const status = await statusWith({
      home, userPrint: { stdout: REGISTERED_ONLY, exitCode: 0 }, lockPid: 44229,
    });
    expect(status.servingPid).toBe(44229);
  });

  it('does not claim a foreign owner when the supervised job is the one serving', async () => {
    const home = await homeWithPlist();
    const status = await statusWith({
      home, userPrint: { stdout: RUNNING, exitCode: 0 }, lockPid: 44229,
    });
    expect(status.supervisedPid).toBe(44229);
    expect(status.servedByForeignProcess).toBe(false);
  });

  it('names a foreign owner when the port answers from a pid the supervisor does not own', async () => {
    // A real listener, because `live` is only true when something actually
    // answers — which is precisely how the false "healthy" reading arose.
    const port = await reserveTestPort();
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    try {
      const home = await homeWithPlist();
      const status = await getIMessageServiceStatus({
        homeDirectory: home,
        port,
        checkHttp: true,
        lockOwnerReader: () => ({ pid: 44229, alive: true }),
        commandRunner: async (_exe: string, args: readonly string[]) =>
          args[1]?.startsWith('system/')
            ? { stdout: '', exitCode: 113 }
            : { stdout: 'state = running\n\tpid = 999\n', exitCode: 0 },
      } as never);

      expect(status.live).toBe(true);
      expect(status.supervisedPid).toBe(999);
      expect(status.servingPid).toBe(44229);
      expect(status.servedByForeignProcess).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('stays silent about ownership when there is no evidence either way', async () => {
    const home = await homeWithPlist();
    const status = await statusWith({
      home, userPrint: { stdout: REGISTERED_ONLY, exitCode: 0 }, lockPid: null,
    });
    // No serving pid known: assert nothing rather than guess.
    expect(status.servedByForeignProcess).toBe(false);
  });

  it('does not accuse a foreign process when the supervised job has no pid to compare', async () => {
    // The port answers and the job is registered but not running. That is worth
    // saying — and it is said by the "registered, not running" path — but it is
    // not evidence that some *other* process is the owner, so do not claim it.
    const status = await withLiveListener(44229, { stdout: REGISTERED_ONLY, exitCode: 0 });

    expect(status.live).toBe(true);
    expect(status.supervisedPid).toBeNull();
    expect(status.running).toBe(false);
    expect(status.servedByForeignProcess).toBe(false);
  });

  it('does not accuse a foreign process when the lock owner is unknown', async () => {
    const status = await withLiveListener(null, { stdout: RUNNING, exitCode: 0 });

    expect(status.live).toBe(true);
    expect(status.servingPid).toBeNull();
    expect(status.servedByForeignProcess).toBe(false);
  });
});
