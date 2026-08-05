/**
 * A running rappter can reach a neighbour. — #126
 *
 * "Through a neighborhood they ALL INTERACT over /twin and /chat." They did
 * not: `sendTwin` had exactly one caller, `twin/cli.ts`, so every exchange in
 * twenty-five ticks of testing happened because a human typed
 * `openrappter twin say`. Asked directly, the alpha agreed:
 *
 *   "No, I cannot send a message to another rappter or the brainstem right now
 *    using only my available tools."
 *
 * That is #100 one level up — that issue was "a rappter can be spoken to and
 * cannot speak", and its fix gave the HUMAN a sender.
 *
 * The safety property matters as much as the capability: a peer is addressed by
 * NAME, resolved through the roster, never by a URL. With the #125 fallback an
 * agent taking a URL would hand a model a general HTTP POST primitive, which is
 * an SSRF vector — #84 is open about DNS rebinding on this codebase.
 */

import { describe, it, expect } from 'vitest';
import { NeighborAgent } from '../../agents/NeighborAgent.js';

async function run(kwargs: Record<string, unknown>) {
  const out = await new NeighborAgent().perform(kwargs);
  return JSON.parse(out) as Record<string, unknown>;
}

describe('a rappter can address a neighbour by name', () => {
  it('refuses a URL rather than resolving it', async () => {
    // The load-bearing refusal. This must never become a general HTTP POST.
    for (const to of [
      'http://evil.example',
      'https://169.254.169.254/latest/meta-data',
      '127.0.0.1:18790/chat',
      'file:///etc/passwd',
    ]) {
      const out = await run({ action: 'say', to, text: 'x' });
      expect(out.status, to).toBe('error');
      expect(String(out.message), to).toMatch(/by name, not by URL/);
    }
  });

  it('refuses a name that is not running rather than guessing a port', async () => {
    const out = await run({ action: 'say', to: 'no-such-neighbour-anywhere', text: 'x' });
    expect(out.status).toBe('error');
    expect(String(out.message)).toMatch(/is running on this device/);
  });

  it('requires both a peer and something to say', async () => {
    expect((await run({ action: 'say', text: 'x' })).status).toBe('error');
    expect((await run({ action: 'say', to: 'alpha' })).status).toBe('error');
    expect((await run({ action: 'say', to: 'alpha', text: '   ' })).status).toBe('error');
  });

  it('lists only neighbours that are actually reachable', async () => {
    // A name offered here that cannot be reached is worse than one omitted —
    // the model would try it and get an error it had been invited into.
    const out = await run({ action: 'list' });
    expect(out.status).toBe('success');
    const reachable = out.reachable as Array<{ name: string; port: number }>;
    expect(Array.isArray(reachable)).toBe(true);
    for (const peer of reachable) {
      expect(typeof peer.name).toBe('string');
      expect(peer.port).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown action instead of defaulting to sending', async () => {
    const out = await run({ action: 'broadcast', to: 'alpha', text: 'x' });
    expect(out.status).toBe('error');
  });

  it('is discoverable by the registry contract', async () => {
    // The registry scans `*Agent.js`, keeps exports whose prototype is a
    // BasicAgent, and calls `new ExportedClass()` with no arguments. An agent
    // that needs constructor arguments is silently never loaded.
    const agent = new NeighborAgent();
    expect(agent.name).toBe('Neighbor');
    expect(typeof agent.perform).toBe('function');
  });
});
