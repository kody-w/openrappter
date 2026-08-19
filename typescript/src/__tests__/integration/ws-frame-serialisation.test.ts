/**
 * A WebSocket reply that cannot be serialised must still be a reply.
 *
 * `sendFrame` was `try { ws.send(JSON.stringify(frame)); } catch { }`. A frame
 * carrying a value `JSON.stringify` refuses -- a cycle, a BigInt -- threw
 * inside that `try` and was swallowed, so the request was never answered at
 * all. The socket stayed open and later calls worked, which is what made it
 * hard to see: nothing looked broken except one request that never came back.
 *
 * The same method over HTTP answers a JSON-RPC error (#361). Over this
 * transport it answered nothing, and a client awaiting `id` cannot tell silence
 * from a hung server -- it waits for its own timeout, or forever if it has
 * none.
 *
 * Verified against a running gateway before the fix: `plugin.good` replied,
 * `plugin.bad` produced `<NO REPLY>`, and `plugin.good` replied again.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';
import { RPC_ERROR } from '../../gateway/types.js';

let server: GatewayServer | undefined;
let socket: WebSocket | undefined;

afterEach(async () => {
  socket?.close();
  socket = undefined;
  await server?.stop();
  server = undefined;
});

function cyclic(): Record<string, unknown> {
  const value: Record<string, unknown> = { ok: true };
  value.self = value;
  return value;
}

interface Frame {
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: number; message?: string };
}

/** Resolve with the frame answering `id`, or null if none arrives in time. */
function call(
  ws: WebSocket,
  id: string,
  method: string,
  params: unknown = {},
  timeoutMs = 3000,
): Promise<Frame | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(null);
    }, timeoutMs);
    function onMessage(data: WebSocket.RawData): void {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

async function connect(): Promise<WebSocket> {
  const port = await reserveTestPort();
  server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
  server.registerMethod('plugin.bad', async () => cyclic());
  server.registerMethod('plugin.big', async () => ({ big: BigInt(1) }));
  server.registerMethod('plugin.good', async () => ({ hello: 'world' }));
  await server.start();

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once('open', resolve));
  await call(ws, 'handshake', 'connect', {
    client: { id: 'test', version: '1.0.0', platform: 'node', mode: 'control' },
  });
  socket = ws;
  return ws;
}

describe('a WebSocket result that cannot be serialised', () => {
  it('is answered, not silently dropped', async () => {
    const ws = await connect();

    const frame = await call(ws, 'r1', 'plugin.bad');
    expect(frame, 'the caller must not be left waiting').not.toBeNull();
    expect(frame?.ok).toBe(false);
    expect(frame?.error?.code).toBe(RPC_ERROR.INTERNAL_ERROR);
  });

  it('answers on the id the caller is waiting for', async () => {
    // Without the correlator the reply is useless: a client demultiplexes on
    // `id`, so an error frame that does not carry it is another silent request.
    const ws = await connect();

    const frame = await call(ws, 'correlate-me', 'plugin.bad');
    expect(frame?.id).toBe('correlate-me');
  });

  it('a BigInt fails the same way as a cycle', async () => {
    const ws = await connect();

    const frame = await call(ws, 'r2', 'plugin.big');
    expect(frame?.ok).toBe(false);
    expect(frame?.error?.code).toBe(RPC_ERROR.INTERNAL_ERROR);
  });

  it('leaves the connection usable', async () => {
    const ws = await connect();

    await call(ws, 'r3', 'plugin.bad');
    const after = await call(ws, 'r4', 'plugin.good');
    expect(after?.ok).toBe(true);
    expect(after?.payload).toEqual({ hello: 'world' });
  });
});

describe('an ordinary WebSocket result', () => {
  it('is unaffected', async () => {
    // Anti-vacuity: serialising into a variable must not change the reply.
    const ws = await connect();

    const frame = await call(ws, 'r5', 'plugin.good');
    expect(frame?.ok).toBe(true);
    expect(frame?.payload).toEqual({ hello: 'world' });
  });
});
