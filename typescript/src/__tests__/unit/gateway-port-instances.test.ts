/**
 * A hatched twin gets its own port, not just its own lock. — #101
 *
 * #94 scoped the runtime lock per instance and stopped there. The port stayed
 * device-global, so this — the flag whose own help text says it exists so an
 * alpha and its hatched twins can share a device:
 *
 *   $ openrappter --daemon --instance scout
 *
 * acquired a lock at ~/.openrappter/instances/scout/gateway.pid, then tried to
 * bind 127.0.0.1:18790, the alpha's port, and died:
 *
 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:18790
 *       at Server.setupListenHandle [as _listen2] (node:net:1908:16)
 *
 * The lock said "you are a separate rappter" and the bind said "you are the
 * alpha". Measured against a healthy alpha before the fix; the alpha survived,
 * so nothing was corrupted — the twin simply never existed.
 *
 * The properties under test are the ones the architecture actually needs: the
 * alpha does not move, a named twin lands somewhere else, and it lands on the
 * SAME somewhere else every time — because a twin that wanders cannot be
 * addressed by a neighbour, and being addressable is the whole point.
 */

import { describe, it, expect } from 'vitest';
import {
  ALPHA_GATEWAY_PORT,
  TWIN_PORT_BASE,
  TWIN_PORT_SPAN,
  gatewayPortFor,
} from '../../infra/gateway-lock.js';

describe('gatewayPortFor — a device runs an alpha plus hatched twins', () => {
  it('leaves the alpha exactly where it was', () => {
    // Nothing already installed may move. The launchd job, burrow.js, the UI
    // and every doc all say 18790.
    expect(gatewayPortFor()).toBe(ALPHA_GATEWAY_PORT);
    expect(gatewayPortFor({})).toBe(ALPHA_GATEWAY_PORT);
    expect(gatewayPortFor({ instance: '' })).toBe(ALPHA_GATEWAY_PORT);
    expect(gatewayPortFor({ instance: '   ' })).toBe(ALPHA_GATEWAY_PORT);
  });

  it('does NOT put a named twin on the alpha port — the actual defect', () => {
    // This is the regression. Before the fix `--instance scout` resolved to
    // 18790 and the process died on bind.
    expect(gatewayPortFor({ instance: 'scout' })).not.toBe(ALPHA_GATEWAY_PORT);
  });

  it('gives the same twin the same port every boot', () => {
    // A twin that moves cannot be reached by a peer that knew it yesterday.
    const first = gatewayPortFor({ instance: 'scout' });
    for (let i = 0; i < 50; i += 1) {
      expect(gatewayPortFor({ instance: 'scout' })).toBe(first);
    }
  });

  it('keeps different twins apart', () => {
    const names = ['scout', 'archivist', 'courier', 'surgeon', 'nightwatch', 'twin-2'];
    const ports = names.map((instance) => gatewayPortFor({ instance }));
    expect(new Set(ports).size).toBe(names.length);
  });

  it('stays inside the twin band, clear of the alpha and the brainstem', () => {
    // 7071 is the brainstem, 7081-7083 are what burrow.js probes, 18790 is the
    // alpha, 49152+ is the kernel's ephemeral range for outbound sockets.
    for (const instance of ['a', 'scout', 'zzzzzzzz', 'twin-with-a-long-name', '9']) {
      const port = gatewayPortFor({ instance });
      expect(port).toBeGreaterThanOrEqual(TWIN_PORT_BASE);
      expect(port).toBeLessThan(TWIN_PORT_BASE + TWIN_PORT_SPAN);
      expect(port).not.toBe(ALPHA_GATEWAY_PORT);
      expect(port).not.toBe(7071);
      expect(port).toBeLessThan(49152);
    }
  });

  it('lets an explicit port overrule the derivation', () => {
    // If a derived port ever does collide with something else on the machine,
    // the owner needs a way out that does not involve renaming the twin.
    expect(gatewayPortFor({ instance: 'scout', port: 19901 })).toBe(19901);
    expect(gatewayPortFor({ port: 19901 })).toBe(19901);
    expect(gatewayPortFor({ port: ALPHA_GATEWAY_PORT })).toBe(ALPHA_GATEWAY_PORT);
  });

  it('is not confused by a garbled port', () => {
    // `Number(undefined)` is NaN, and binding NaN listens on a random port —
    // which would make a twin unaddressable in the one way that matters.
    expect(gatewayPortFor({ instance: 'scout', port: Number.NaN }))
      .toBe(gatewayPortFor({ instance: 'scout' }));
    expect(gatewayPortFor({ port: Number.NaN })).toBe(ALPHA_GATEWAY_PORT);
  });

  it('derives the same port from a name on any machine', () => {
    // Pinned literals. The derivation is part of how one rappter addresses
    // another, so changing it silently would break peers that already know
    // where a twin lives — this test makes that change loud.
    expect(gatewayPortFor({ instance: 'scout' })).toBe(19_509);
    expect(gatewayPortFor({ instance: 'alpha' })).toBe(19_517);
  });
});
