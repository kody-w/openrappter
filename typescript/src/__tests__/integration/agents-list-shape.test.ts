import { describe, it, expect } from 'vitest';
import { GatewayServer } from '../../gateway/server.js';

/**
 * `agents.list` answers with a shape, and that shape must not drift.
 *
 * The two runtimes disagree about what this method returns:
 *
 *     TypeScript  [{ id, type, description }]
 *     Python      [{ name, description, parameters, module, file, source }]
 *
 * Exactly one key overlaps, and this runtime's `id` is Python's `name`, so a
 * client written against either cannot read the other. The macOS Bar
 * (`RpcClient.swift`), the dashboard (`ui/src/components/agents.ts`) and the
 * TUI all call it typed as the shape below.
 *
 * Which shape should be canonical is an open product question (#198) with real
 * callers on both sides, and nothing here decides it. These tests stop the
 * shapes drifting *further* apart while it is decided.
 *
 * `contracts/gateway-rpc-parity.json` states in its own words that it pins
 * method names "and nothing about what they answer with". This is the missing
 * half for the one shared method where that distinction has consequences.
 */

const EXPECTED_KEYS = ['description', 'id', 'type'];

async function listFrom(
  entries: { id: string; type: string; description?: string }[],
): Promise<Record<string, unknown>[]> {
  const server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  server.setAgentList(() => entries);
  try {
    await server.start();
    const entry = (server as unknown as {
      methods: Map<string, { handler: (p: unknown, c: unknown) => Promise<unknown> }>;
    }).methods.get('agents.list');
    expect(entry, 'agents.list should be registered').toBeDefined();
    return (await entry!.handler({}, {})) as Record<string, unknown>[];
  } finally {
    await server.stop();
  }
}

describe('agents.list payload shape', () => {
  it('returns the entries the runtime supplies', async () => {
    // Anti-vacuity: every assertion below is about an entry, so an empty
    // listing would make them pass by having nothing to check.
    const list = await listFrom([
      { id: 'Echo', type: 'echo', description: 'echoes' },
    ]);
    expect(list).toHaveLength(1);
  });

  it('every entry carries exactly the documented keys', async () => {
    const list = await listFrom([
      { id: 'Echo', type: 'echo', description: 'echoes' },
      { id: 'Shell', type: 'shell', description: 'runs commands' },
    ]);
    for (const entry of list) {
      expect(
        Object.keys(entry).sort(),
        'agents.list changed shape — one half of the #198 divergence. '
          + 'Changing it is fine; changing it silently is not.',
      ).toEqual(EXPECTED_KEYS);
    }
  });

  it('names the identifier `id`, which Python calls `name`', async () => {
    // The rename is the divergence's sharpest edge: both runtimes answer the
    // same method with a differently-named identifier, so a client reading the
    // wrong one gets undefined rather than an error.
    const [entry] = await listFrom([
      { id: 'Echo', type: 'echo', description: 'echoes' },
    ]);
    expect(entry).toHaveProperty('id');
    expect(entry).not.toHaveProperty('name');
  });

  it('shares only `description` with the Python shape', async () => {
    const pythonKeys = new Set([
      'name', 'description', 'parameters', 'module', 'file', 'source',
    ]);
    const [entry] = await listFrom([
      { id: 'Echo', type: 'echo', description: 'echoes' },
    ]);
    const shared = Object.keys(entry).filter((k) => pythonKeys.has(k));
    expect(shared).toEqual(['description']);
  });
});
