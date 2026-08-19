/**
 * A device runs an alpha rappter plus any number of hatched twins. — #94
 *
 * The runtime lock was one file per home directory:
 *
 *   openrappterPath('gateway.pid')
 *
 * No port, no instance in the path, and `index.ts` called `acquireLock()` with
 * no arguments — so exactly ONE rappter could run per machine. Measured before
 * this change: a daemon started on a *different port* still died on the lock.
 * The lock was never per-port; it was per-device.
 *
 * That is incompatible with the architecture this product is for, where an
 * alpha and its twins meet as peers over /twin and /chat and none of them can
 * tell what kind of peer answered.
 *
 * It also produced a failure nobody could read. `com.openrappter.gateway`
 * started seven times and exited 1 every time — not an orphan, not a stale job,
 * just a second instance being refused — and three separate diagnoses of that
 * were wrong before the singleton was found to be the cause.
 *
 * The two properties under test: the alpha's path does not move, and two
 * instances can hold locks at once.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { openrappterPath } from '../../infra/openrappter-home.js';
import { join } from 'node:path';
import {
  ALPHA_GATEWAY_PORT,
  defaultGatewayLockFile,
  acquireLock,
  gatewayLockFileFor,
  releaseLock,
} from '../../infra/gateway-lock.js';

const held: string[] = [];
afterEach(() => {
  for (const f of held.splice(0)) {
    try { releaseLock({ filePath: f }); } catch { /* already gone */ }
  }
});

function take(filePath: string, pid: number): boolean {
  const ok = acquireLock({ filePath, pid });
  if (ok) held.push(filePath);
  return ok;
}

describe('the alpha is exactly where it always was', () => {
  it('resolves to the original path with no arguments', () => {
    expect(gatewayLockFileFor()).toBe(defaultGatewayLockFile());

    // The guarantee this file is about is that an existing install is never
    // migrated. Expressed against openrappterPath so it still holds when
    // OPENRAPPTER_HOME relocates the install, and asserted directly below for
    // the default case, which is the one existing users are in.
    expect(defaultGatewayLockFile()).toBe(openrappterPath('gateway.pid'));
  });

  it('is the historical ~/.openrappter path when nothing overrides it', () => {
    // The compatibility promise stated literally, for the case every existing
    // user is in. The assertions above use openrappterPath so they survive a
    // relocated install; this one pins that a default install did not move.
    const saved = process.env.OPENRAPPTER_HOME;
    delete process.env.OPENRAPPTER_HOME;
    try {
      expect(defaultGatewayLockFile()).toBe(join(homedir(), '.openrappter', 'gateway.pid'));
    } finally {
      if (saved === undefined) delete process.env.OPENRAPPTER_HOME;
      else process.env.OPENRAPPTER_HOME = saved;
    }
  });

  // An existing install passes its port explicitly; it must not be migrated.
  it('resolves to the original path on the default port', () => {
    expect(gatewayLockFileFor({ port: ALPHA_GATEWAY_PORT })).toBe(defaultGatewayLockFile());
  });
});

describe('a twin gets its own', () => {
  it('keys by port when no id is given', () => {
    const twin = gatewayLockFileFor({ port: 19901 });
    expect(twin).not.toBe(defaultGatewayLockFile());
    expect(twin).toBe(openrappterPath('instances', '19901', 'gateway.pid'));
  });

  it('prefers an explicit id over the port', () => {
    expect(gatewayLockFileFor({ instance: 'scout', port: 19901 }))
      .toBe(openrappterPath('instances', 'scout', 'gateway.pid'));
  });

  // A twin id reaches a filesystem path. It must not be able to walk out of
  // the instances directory and seize the alpha's lock.
  it('cannot escape the instances directory', () => {
    for (const evilId of ['../../gateway', '..', '../..', '/etc/passwd', '']) {
      const p = gatewayLockFileFor({ instance: evilId, port: 19901 });
      expect(p, evilId).not.toBe(defaultGatewayLockFile());
      expect(p, evilId).toContain(join('.openrappter', 'instances'));
    }
  });

  // `..` survives a naive separator-strip untouched and joins straight back to
  // ~/.openrappter/gateway.pid — the alpha's own file. Found by this test.
  it('does not let an id of only dots resolve to the alpha', () => {
    for (const dots of ['..', '.', '...']) {
      const p = gatewayLockFileFor({ instance: dots, port: 19901 });
      expect(p, dots).not.toBe(defaultGatewayLockFile());
      expect(p, dots).toContain(join('.openrappter', 'instances'));
    }
  });
});

describe('two rappters can hold locks at the same time', () => {
  // THE POINT OF #94. Before this, the second call returned false.
  it('lets an alpha and a twin run together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rappters-'));
    try {
      const alpha = join(dir, 'alpha', 'gateway.pid');
      const twin = join(dir, 'instances', 'scout', 'gateway.pid');

      expect(take(alpha, 1001)).toBe(true);
      expect(take(twin, 1002)).toBe(true);   // ← used to be false

      expect(existsSync(alpha)).toBe(true);
      expect(existsSync(twin)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still refuses a second holder of the SAME instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rappters-'));
    try {
      const same = join(dir, 'instances', 'scout', 'gateway.pid');
      expect(take(same, 2001)).toBe(true);
      // Scoping the lock must not weaken it — one instance is still one process.
      expect(acquireLock({ filePath: same, pid: 2002 })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets three twins coexist, because a neighborhood is not two', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rappters-'));
    try {
      for (const [i, name] of ['alpha', 'scout', 'archivist'].entries()) {
        expect(take(join(dir, name, 'gateway.pid'), 3000 + i), name).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
