import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GatewayServer } from '../../gateway/server.js';

/**
 * The TypeScript gateway registers the shared RPC surface, and nothing that the
 * contract says belongs to Python alone.
 *
 * The two gateways drifted and nothing noticed: Python registers
 * `agents.execute` and TypeScript does not, while the macOS Bar carries an
 * `executeAgent()` wrapper for that name. So the same Bar could execute agents
 * against a Python gateway and not against a TypeScript one.
 *
 * Different sizes are expected — TypeScript is the full daemon, with cron, chat,
 * twin, surgeon and more. What must not happen is the *overlap* disagreeing, or
 * a method appearing in one runtime only without anyone saying so.
 *
 * `contracts/gateway-rpc-parity.json` is the pin. Python has the matching test.
 */

const CONTRACT = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../contracts/gateway-rpc-parity.json'), 'utf-8'),
) as {
  shared: string[];
  python_only: Record<string, string[]>;
  health_checks: { shared: string[]; typescript_only: Record<string, string[]> };
  what_this_does_not_pin?: string[];
};

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function registered(): Promise<Set<string>> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  await server.start();
  return new Set((server as unknown as { methods: Map<string, unknown> }).methods.keys());
}

describe('gateway RPC parity with the Python runtime', () => {
  it('the contract lists something', () => {
    // Guards the rest: an empty contract would make every assertion vacuous.
    expect(CONTRACT.shared.length).toBeGreaterThan(4);
  });

  it('says plainly that it does not pin response shapes', () => {
    // `agents.list` is shared, and the two runtimes return payloads with
    // almost nothing in common — TypeScript `{ id, type, description }`,
    // Python `{ name, description, parameters, module, file, source }`.
    // Without this note, "shared" reads as though a client could consume
    // either, which it cannot.
    const note = (CONTRACT.what_this_does_not_pin ?? []).join(' ');
    expect(note).toContain('Response shapes');
    expect(note).toContain('agents.list');
  });

  it('registers every shared method', async () => {
    const have = await registered();
    const missing = CONTRACT.shared.filter((m) => !have.has(m)).sort();
    expect(missing).toEqual([]);
  });

  it('does not register anything the contract reserves to Python', async () => {
    // If TypeScript gains one of these, it is no longer python-only and the
    // contract must move it to `shared` — with the security thinking that
    // implies for `agents.execute`, which executes a named agent.
    const have = await registered();
    const crossed = Object.keys(CONTRACT.python_only).filter((m) => have.has(m)).sort();
    expect(crossed).toEqual([]);
  });
});

describe('health checks parity with the Python runtime', () => {
  /**
   * `health` is shared, and `checks` is the part a monitor actually reads. The
   * contract described it in prose as agreeing between the runtimes; it did
   * not — TypeScript reported five checks and Python two. Prose cannot fail a
   * build, so the disagreement survived. Python has the matching test.
   */
  async function healthChecks(): Promise<Set<string>> {
    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();
    const method = (server as unknown as {
      methods: Map<string, { handler: () => Promise<{ checks: Record<string, unknown> }> }>;
    }).methods.get('health')!;
    return new Set(Object.keys((await method.handler()).checks));
  }

  it('the contract declares the check names', () => {
    // Guards the rest: an empty list would make every assertion vacuous.
    expect(CONTRACT.health_checks.shared.length).toBeGreaterThanOrEqual(4);
  });

  it('reports every shared check', async () => {
    const have = await healthChecks();
    const missing = CONTRACT.health_checks.shared.filter((c) => !have.has(c)).sort();
    expect(missing).toEqual([]);
  });

  it('reports nothing beyond shared plus its own declared extras', async () => {
    // The whole point: a new check cannot appear without being classified,
    // which is how `checks` drifted apart unnoticed in the first place.
    const explained = new Set([
      ...CONTRACT.health_checks.shared,
      ...Object.keys(CONTRACT.health_checks.typescript_only),
    ]);
    const unexplained = [...(await healthChecks())].filter((c) => !explained.has(c)).sort();
    expect(unexplained).toEqual([]);
  });
});
