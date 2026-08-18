import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

/**
 * The advertised payload limit has to be the enforced one.
 *
 * `handleConnect` has always reported `policy.maxPayload: 5_000_000`, and
 * `WebSocketServer` was constructed without a `maxPayload` option — so `ws`
 * applied its own default of 100 MB. The gateway told every client its limit
 * was 5 MB and accepted twenty times that.
 *
 * The number existed in two places and only one of them did anything, which is
 * why this asserts the two agree rather than asserting a literal: a limit that
 * is merely written down is the thing that failed here.
 */

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function handshake(port: number): Promise<Record<string, unknown>> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(String(data))));
    });
    ws.send(JSON.stringify({
      type: 'req',
      id: '1',
      method: 'connect',
      params: { client: { id: 'test', version: '1', platform: 'test', mode: 'test' } },
    }));
    return await reply;
  } finally {
    ws.close();
  }
}

describe('gateway payload limit', () => {
  it('enforces the limit it advertises', async () => {
    const port = await reserveTestPort();
    server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();

    const res = await handshake(port);
    const payload = res.payload as { policy?: { maxPayload?: number } } | undefined;
    const advertised = payload?.policy?.maxPayload;
    expect(typeof advertised).toBe('number');

    // A frame one byte over the advertised limit must be refused. `ws` closes
    // with 1009 (message too big) rather than answering, so the close code is
    // the observable.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 200_000_000 });
    const closed = new Promise<number>((resolve) => {
      ws.once('close', (code) => resolve(code));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send('x'.repeat((advertised as number) + 1));

    await expect(closed).resolves.toBe(1009);
  }, 30_000);

  it('accepts a frame comfortably inside the limit', async () => {
    const port = await reserveTestPort();
    server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();

    const res = await handshake(port);
    // The handshake itself is the proof: a connection that completes a request
    // and gets an answer has not been closed for size.
    expect(res.ok).toBe(true);
  }, 30_000);
});
