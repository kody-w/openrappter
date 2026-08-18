import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';

import { GatewayServer } from '../../gateway/server.js';
import { reserveTestPort } from '../support/test-port.js';

/**
 * A client that stops reading must not be buffered without limit.
 *
 * The handshake has always advertised `policy.maxBufferedBytes`, and
 * `sendFrame` was `ws.send(...)` with nothing consulting `bufferedAmount`. The
 * limit was announced and never applied. `zen.publish` carries frames of up to
 * 256 KB at up to 30fps, so a subscriber that stalls can accumulate megabytes a
 * second in a process meant to run for weeks.
 *
 * The guard is exercised directly with a stub socket rather than by trying to
 * stall a real client: making a real peer stop reading on demand is unreliable,
 * and a flaky test about resource exhaustion is worse than a direct one.
 */

interface FrameSender {
  sendFrame(ws: unknown, frame: Record<string, unknown>): void;
}

interface StubSocket {
  bufferedAmount: number;
  sent: string[];
  closedWith: [number, string] | null;
  send(data: string): void;
  close(code: number, reason: string): void;
}

function stubSocket(bufferedAmount: number): StubSocket {
  return {
    bufferedAmount,
    sent: [],
    closedWith: null,
    send(data: string) { this.sent.push(data); },
    close(code: number, reason: string) { this.closedWith = [code, reason]; },
  };
}

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function advertisedLimit(port: number): Promise<number> {
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
    const res = await reply;
    const payload = res.payload as { policy: { maxBufferedBytes: number } };
    return payload.policy.maxBufferedBytes;
  } finally {
    ws.close();
  }
}

describe('gateway outbound buffer limit', () => {
  it('enforces the buffer limit it advertises', async () => {
    const port = await reserveTestPort();
    server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
    await server.start();

    const limit = await advertisedLimit(port);
    expect(typeof limit).toBe('number');

    const sender = server as unknown as FrameSender;

    // Comfortably inside the limit: the frame goes out.
    const healthy = stubSocket(limit - 1);
    sender.sendFrame(healthy, { type: 'event', name: 'tick' });
    expect(healthy.sent).toHaveLength(1);
    expect(healthy.closedWith).toBeNull();

    // Past it: nothing more is queued, and the connection is closed rather than
    // left to grow.
    const stalled = stubSocket(limit + 1);
    sender.sendFrame(stalled, { type: 'event', name: 'tick' });
    expect(stalled.sent).toHaveLength(0);
    expect(stalled.closedWith?.[0]).toBe(1013);
  }, 30_000);
});
