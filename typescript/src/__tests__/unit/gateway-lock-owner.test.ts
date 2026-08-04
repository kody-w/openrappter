/**
 * Tests for gateway lock ownership reporting (second half of #44).
 *
 * `isGatewayRunning()` answers *whether* the gateway is held, which is not
 * enough to debug the case that actually bites: a second supervisor holding the
 * lock while the installed launch agent loops on "Another OpenRappter gateway
 * already owns the runtime lock". `install-service` then reports live/ready for
 * a listener it does not own, and the symptoms read as a credential problem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { readGatewayLockOwner } from '../../infra/gateway-lock.js';
import { diagnoseIMessage } from '../../channels/imessage-diagnostics.js';

let dir: string;
let lockFile: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-lock-'));
  lockFile = path.join(dir, 'gateway.pid');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readGatewayLockOwner', () => {
  it('reports the live process recorded in the lock file', async () => {
    await fs.writeFile(lockFile, String(process.pid));
    expect(readGatewayLockOwner({ filePath: lockFile }))
      .toEqual({ pid: process.pid, alive: true });
  });

  it('reports a recorded pid that is no longer running as stale', async () => {
    // PID 2^22 is above the default macOS/Linux pid_max and is not in use.
    await fs.writeFile(lockFile, '4194304');
    expect(readGatewayLockOwner({ filePath: lockFile }))
      .toEqual({ pid: 4194304, alive: false });
  });

  it('reports no owner when the lock file is absent', () => {
    expect(readGatewayLockOwner({ filePath: path.join(dir, 'absent.pid') }))
      .toEqual({ pid: null, alive: false });
  });

  it('treats a malformed lock file as unowned rather than throwing', async () => {
    await fs.writeFile(lockFile, 'not-a-pid');
    expect(readGatewayLockOwner({ filePath: lockFile })).toEqual({ pid: null, alive: false });
  });

  it('rejects a non-positive pid', async () => {
    await fs.writeFile(lockFile, '0');
    expect(readGatewayLockOwner({ filePath: lockFile })).toEqual({ pid: null, alive: false });
  });

  it('tolerates trailing content after the pid', async () => {
    await fs.writeFile(lockFile, `${process.pid}\n`);
    expect(readGatewayLockOwner({ filePath: lockFile }).pid).toBe(process.pid);
  });
});

describe('diagnoseIMessage surfaces a foreign gateway owner', () => {
  const LABEL = 'com.openrappter.gateway';

  /** Drive the real service-status path: plist on disk, launchctl print fails. */
  async function optionsWith(loaded: boolean, lockOwner: { pid: number | null; alive: boolean }) {
    const agentDir = path.join(dir, 'Library', 'LaunchAgents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, `${LABEL}.plist`), '<plist/>');
    return {
      config: { enabled: true, allowFrom: ['+15551234567'] },
      tokenConfigured: true,
      platform: 'darwin' as NodeJS.Platform,
      homeDirectory: dir,
      accessFile: async () => undefined,
      lockOwnerReader: () => lockOwner,
      commandRunner: async (_exe: string, args: readonly string[]) =>
        args[0] === 'print'
          ? { stdout: loaded ? "state = running" : "", exitCode: loaded ? 0 : 113 }
          : { stdout: "1", exitCode: 0 },
      launchAgent: { homeDirectory: dir, checkHttp: false },
    };
  }

  it('flags a live lock owner while the installed agent is not loaded', async () => {
    const result = await diagnoseIMessage(
      await optionsWith(false, { pid: 4242, alive: true }) as never,
    );
    expect(result.lockOwner).toEqual({ pid: 4242, alive: true });
    expect(result.service.installed).toBe(true);
    expect(result.service.loaded).toBe(false);
    expect(result.reasons).toContain('gateway_lock_foreign');
  });

  it('does not flag when the installed agent is the loaded supervisor', async () => {
    const result = await diagnoseIMessage(
      await optionsWith(true, { pid: 4242, alive: true }) as never,
    );
    expect(result.reasons).not.toContain('gateway_lock_foreign');
  });

  it('does not flag a stale lock file', async () => {
    const result = await diagnoseIMessage(
      await optionsWith(false, { pid: 4242, alive: false }) as never,
    );
    expect(result.reasons).not.toContain('gateway_lock_foreign');
  });
});
