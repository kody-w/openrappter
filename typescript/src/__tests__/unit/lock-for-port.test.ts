/**
 * `servingPid` and `live` must describe the same rappter. — #109
 *
 * `IMessageServiceStatus.servingPid` is documented as "the pid holding the
 * gateway runtime lock — i.e. what actually answered live/ready". It read the
 * ALPHA's lock unconditionally, whatever port was asked about.
 *
 * Measured with a real twin, both pids confirmed by `lsof -sTCP:LISTEN`:
 *
 *   alpha  18790 -> pid 66014
 *   scout  19509 -> pid 71257
 *
 *   service-status --port 18790 => live=True servingPid=66014 foreign=False
 *   service-status --port 19509 => live=True servingPid=66014 foreign=False
 *                                        ^ scout answered   ^ but this is the alpha
 *
 * The second row probed 19509, scout answered it, and the result attributed
 * that liveness to a process with nothing to do with the response.
 *
 * The consequence that matters is `servedByForeignProcess`, whose only job is
 * to notice that a port is being served by something other than the supervised
 * job. Built on the wrong pid it was structurally unable to fire for any
 * non-alpha port — and a check that cannot fail reads as a pass.
 *
 * A twin's lock is keyed by NAME (`instances/scout/gateway.pid`) and a name
 * cannot be recovered from a port, so the mapping goes through the endpoint
 * record each rappter writes at startup (#107).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  ALPHA_GATEWAY_PORT,
  defaultGatewayLockFile,
  gatewayEndpointFileFor,
  gatewayLockFileFor,
  gatewayLockFileForPort,
} from '../../infra/gateway-lock.js';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A private HOME so nothing here reads or writes the real machine. */
function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'lockport-home-'));
  homes.push(home);
  vi.stubEnv('HOME', home);
  return home;
}

function recordEndpoint(instance: string | undefined, port: number): void {
  const file = gatewayEndpointFileFor(instance ? { instance } : {});

  // Refuse to write outside the sandbox this test created.
  //
  // Without this guard the test is only as isolated as the module it is
  // testing. When `defaultGatewayLockFile()` froze home at import time (#110),
  // `gatewayEndpointFileFor({})` resolved to the operator's REAL
  // ~/.openrappter/endpoint.json, this helper wrote its fixture there, and the
  // live roster began reporting a running alpha as dead. It happened twice —
  // once from the original test, and again from the negative control that
  // deliberately reintroduced the bug, because a control that restores a
  // destructive defect also restores the destruction.
  //
  // Failing loudly is the only acceptable outcome: a regression should break
  // this test, never the machine running it.
  const sandbox = homes[homes.length - 1];
  if (!sandbox || !file.startsWith(sandbox)) {
    throw new Error(
      `refusing to write a test fixture outside the sandbox\n`
      + `  sandbox: ${sandbox}\n`
      + `  target:  ${file}\n`
      + `  This means HOME redirection is not reaching this path — see #110.`,
    );
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    ...(instance ? { instance } : {}),
    port,
    pid: 4242,
    startedAt: '2026-08-05T09:00:00.000Z',
  }));
}

describe('a port resolves to the lock of the rappter actually on it', () => {
  it('finds a twin by the port it recorded, not by its name', () => {
    isolatedHome();
    recordEndpoint('scout', 19_509);

    // The heart of #109. A twin's lock lives under its NAME, so nothing about
    // the number 19509 leads here without the record.
    expect(gatewayLockFileForPort(19_509))
      .toBe(gatewayLockFileFor({ instance: 'scout' }));
    expect(gatewayLockFileForPort(19_509)).toContain('scout');
  });

  it('does NOT hand back the alpha lock for a twin port — the actual defect', () => {
    isolatedHome();
    recordEndpoint('scout', 19_509);
    expect(gatewayLockFileForPort(19_509)).not.toBe(defaultGatewayLockFile());
  });

  it('still resolves the alpha to its original file', () => {
    isolatedHome();
    expect(gatewayLockFileForPort(ALPHA_GATEWAY_PORT)).toBe(defaultGatewayLockFile());
  });

  it('recognises an alpha that was started on a non-default port', () => {
    isolatedHome();
    recordEndpoint(undefined, 19_001);
    expect(gatewayLockFileForPort(19_001)).toBe(defaultGatewayLockFile());
    // ...and stops claiming the default port it is no longer on.
    expect(gatewayLockFileForPort(ALPHA_GATEWAY_PORT)).not.toBe(defaultGatewayLockFile());
  });

  it('keeps twins apart when several are recorded', () => {
    isolatedHome();
    recordEndpoint('scout', 19_509);
    recordEndpoint('archivist', 19_950);

    expect(gatewayLockFileForPort(19_509)).toContain('scout');
    expect(gatewayLockFileForPort(19_950)).toContain('archivist');
    expect(gatewayLockFileForPort(19_509)).not.toBe(gatewayLockFileForPort(19_950));
  });

  it('does not attribute an unclaimed port to the alpha', () => {
    isolatedHome();
    recordEndpoint('scout', 19_509);

    // Nothing recorded 19777. Guessing the alpha here is precisely the failure
    // being removed: it would report the alpha as serving a stranger's port.
    const resolved = gatewayLockFileForPort(19_777);
    expect(resolved).not.toBe(defaultGatewayLockFile());
    expect(resolved).toContain('19777');
  });

  it('survives a machine that has never hatched anything', () => {
    isolatedHome();
    expect(() => gatewayLockFileForPort(19_509)).not.toThrow();
    expect(gatewayLockFileForPort(ALPHA_GATEWAY_PORT)).toBe(defaultGatewayLockFile());
  });

  it('resolves the alpha path against the CURRENT home, like every other path — #110', () => {
    // This used to be a constant frozen at import time while instance paths
    // re-read homedir() on every call. Redirecting HOME therefore moved every
    // twin's files and left the alpha's behind, so the test above — which
    // believed it was isolated — wrote its fixture into the operator's real
    // ~/.openrappter/endpoint.json and made the live roster report a running
    // alpha as dead.
    const home = isolatedHome();
    expect(defaultGatewayLockFile()).toBe(join(home, '.openrappter', 'gateway.pid'));
    expect(defaultGatewayLockFile().startsWith(home)).toBe(true);

    // Both families must move together, or a caller cannot tell which machine
    // it is describing.
    expect(gatewayLockFileFor({ instance: 'scout' }).startsWith(home)).toBe(true);
    expect(gatewayEndpointFileFor({}).startsWith(home)).toBe(true);
  });
});
