import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayServer, type WorkRappAdapter } from '../server.js';
import { RPC_ERROR } from '../types.js';

const TOKEN = 'rapp-work-adapter-test-token';
let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot(adapter?: WorkRappAdapter): Promise<void> {
  server = new GatewayServer({
    port: 0,
    bind: 'loopback',
    auth: { mode: 'token', tokens: [TOKEN] },
    heartbeatInterval: 60_000,
  }, { workRappAdapter: adapter });
  await server.start();
}

async function rpc(method: string, params: unknown, token = TOKEN) {
  const response = await fetch(`http://127.0.0.1:${server!.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', token].join(' '),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return response.json() as Promise<{
    result?: unknown;
    error?: { code: number; message: string };
  }>;
}

describe('production RAPP Work adapter RPCs', () => {
  it('registers both authenticated contracts and refuses unauthenticated access', async () => {
    await boot();
    const methods = await rpc('methods', {});
    expect(methods.result).toEqual(expect.arrayContaining([
      'work.rapp.verify',
      'work.rapp.commit',
    ]));
    const denied = await rpc('work.rapp.verify', {}, 'wrong');
    expect(denied.error?.code).toBe(RPC_ERROR.UNAUTHORIZED);
  });

  it('fails closed when no trusted persistence adapter is installed', async () => {
    await boot();
    for (const method of ['work.rapp.verify', 'work.rapp.commit']) {
      const reply = await rpc(method, {});
      expect(reply.result).toBeUndefined();
      expect(reply.error).toMatchObject({
        code: RPC_ERROR.INTERNAL_ERROR,
        message: expect.stringContaining('persistence adapter is unavailable'),
      });
    }
  });

  it('delegates exact requests to the host-owned adapter', async () => {
    const adapter: WorkRappAdapter = {
      verify: vi.fn(async (claim) => ({ claim })),
      commit: vi.fn(async (request) => ({ request })),
    };
    await boot(adapter);
    const claim = { scope: 'vm', subject: 'vm:omarchy', data: { state: 'stopped' } };
    const request = { method: 'vm.start', subject: 'vm:omarchy', params: {}, basis: {} };
    expect((await rpc('work.rapp.verify', claim)).result).toEqual({ claim });
    expect((await rpc('work.rapp.commit', request)).result).toEqual({ request });
    expect(adapter.verify).toHaveBeenCalledWith(claim);
    expect(adapter.commit).toHaveBeenCalledWith(request);
  });
});
