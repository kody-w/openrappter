/**
 * One canonical key per rappter, used everywhere. — #111
 *
 * A rappter's identity was computed two ways: `gatewayPortFor` hashed the RAW
 * name, `gatewayLockFileFor` keyed the path on a SANITISED one. Names that
 * flatten alike therefore wanted different ports while sharing a single lock,
 * endpoint record and roster row:
 *
 *   "a b"   port 19884  lockdir a_b/
 *   "a_b"   port 19291  lockdir a_b/
 *
 * Live, that produced a success message about the wrong rappter:
 *
 *   $ openrappter hatch "a b"   -> Hatching a b on :19884 (pid 85246)
 *   $ openrappter hatch "a_b"   -> a_b is already running on :19884 (pid 85246)
 *
 * `a_b` was never started. Nothing failed and nothing warned.
 *
 * This is #101 — the lock and the port disagreeing about which rappter a
 * process is — surviving inside the very module that fix created, because one
 * side hashed the raw string and the other the cleaned one.
 */

import { describe, it, expect } from 'vitest';
import {
  ALPHA_GATEWAY_PORT,
  canonicalInstanceKey,
  gatewayEndpointFileFor,
  gatewayLockFileFor,
  gatewayPortFor,
} from '../../infra/gateway-lock.js';

/** Everything a rappter's identity is derived into. */
function identityOf(instance: string) {
  return {
    port: gatewayPortFor({ instance }),
    lock: gatewayLockFileFor({ instance }),
    endpoint: gatewayEndpointFileFor({ instance }),
  };
}

describe('a rappter has one identity, not two', () => {
  it('gives names that share a lock the SAME port — the actual defect', () => {
    for (const [a, b] of [['a b', 'a_b'], ['team/one', 'team_one']] as const) {
      expect(gatewayLockFileFor({ instance: a }))
        .toBe(gatewayLockFileFor({ instance: b }));
      // Before this change these differed: 19884 vs 19291, and 19391 vs 19630.
      expect(gatewayPortFor({ instance: a }))
        .toBe(gatewayPortFor({ instance: b }));
    }
  });

  it('agrees on every derived path for aliases of one name', () => {
    expect(identityOf('a b')).toEqual(identityOf('a_b'));
    expect(identityOf('team/one')).toEqual(identityOf('team_one'));
  });

  it('does NOT move any name that was already canonical', () => {
    // The migration hazard. Every twin hatched before this change must keep the
    // port it has, or a peer that knew where it lived stops being able to reach
    // it. Pinned literals, measured before the change.
    expect(gatewayPortFor({ instance: 'scout' })).toBe(19_509);
    expect(gatewayPortFor({ instance: 'alpha' })).toBe(19_517);
    expect(gatewayPortFor({ instance: 'archivist' })).toBe(19_591);
    expect(gatewayPortFor({ instance: 'courier' })).toBe(19_282);

    for (const name of ['scout', 'archivist', 'a-b', 'twin-2', 'x.y_z']) {
      expect(canonicalInstanceKey(name)).toBe(name);
    }
  });

  it('keeps genuinely different names apart', () => {
    // Canonicalising must not turn everything into one rappter.
    const names = ['scout', 'archivist', 'courier', 'a-b', 'a_b'];
    const ports = names.map((instance) => gatewayPortFor({ instance }));
    expect(new Set(ports).size).toBe(names.length);
  });

  it('still refuses to let a name escape the instances directory', () => {
    // The sanitiser's original job. `..` survives character replacement intact
    // and would resolve the join back to the alpha's own lock file.
    for (const evil of ['..', '.', '../..', '../../alpha', '', '   ']) {
      const key = canonicalInstanceKey(evil);
      expect(key).not.toBe('');
      expect(/^\.+$/.test(key)).toBe(false);
      expect(key).not.toContain('/');
    }
    expect(gatewayLockFileFor({ instance: '../../alpha' }))
      .not.toBe(gatewayLockFileFor({}));
  });

  it('leaves the alpha alone', () => {
    expect(gatewayPortFor({})).toBe(ALPHA_GATEWAY_PORT);
    expect(gatewayPortFor({ instance: '' })).toBe(ALPHA_GATEWAY_PORT);
    expect(gatewayLockFileFor({})).toBe(gatewayLockFileFor({ port: ALPHA_GATEWAY_PORT }));
  });

  it('is stable — the same name canonicalises to itself', () => {
    // Applying it twice must not keep changing the answer, or a name would
    // drift every time it round-trips through the roster.
    for (const name of ['a b', 'team/one', '..', 'scout', 'weird!!name']) {
      const once = canonicalInstanceKey(name);
      expect(canonicalInstanceKey(once)).toBe(once);
    }
  });
});
