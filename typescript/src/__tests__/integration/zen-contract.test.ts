/**
 * Zen viewer RPC contract, against the wired gateway.
 *
 * `ui/src/components/zen.ts` is live UI (`<openrappter-zen>`, rendered from
 * `ui/src/main.ts`) and it called three methods the production gateway never
 * registered:
 *
 *     zen.sessions     → -32601 Method not found: zen.sessions
 *     zen.subscribe    → -32601 Method not found: zen.subscribe
 *     zen.unsubscribe  → -32601 Method not found: zen.unsubscribe
 *
 * `src/gateway/methods/zen-methods.ts` declares those names, but it is
 * deliberately never registered (see the doc comment on
 * `registerBuiltInMethods`) *and* it reads a process-local singleton
 * (`peer-stream.ts`'s `globalPeerStream`) whose only writer, `src/tui/bar.ts`,
 * runs in the Bar's process — never the daemon's. Registering it would have
 * turned "Method not found" into a permanently empty session list, which the
 * user cannot tell apart from "nothing is streaming right now".
 *
 * These tests therefore drive a real `GatewayServer` over real HTTP and real
 * WebSocket connections. A test importing the method module would prove
 * nothing about the server the dashboard talks to.
 */
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from '../../gateway/server.js';
import { TuiGatewayClient } from '../../tui/gateway-client.js';
import { createZenPublisher } from '../../tui/zen-publisher.js';

let server: GatewayServer | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await server?.stop();
  server = undefined;
});

async function startServer(): Promise<number> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  await server.start();
  const port = server.port;
  return port;
}

async function httpRpc(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'zen-test', method, params }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

/** A minimal client speaking the gateway's real frame protocol over ws. */
class TestClient {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly events: Array<{ event: string; payload: Record<string, unknown> }> = [];

  private constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'res') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.payload);
        else pending.reject(new Error(frame.error?.message ?? 'rpc error'));
      } else if (frame.type === 'event') {
        this.events.push({ event: frame.event, payload: frame.payload });
      }
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const client = new TestClient(port);
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.ws.once('open', () => resolve());
      client.ws.once('error', reject);
    });
    await client.call('connect', {
      client: { id: 'zen-test', version: 'test', platform: process.platform, mode: 'test' },
    });
    return client;
  }

  call<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = `t${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, 5000);
    });
  }

  framesFor(sessionId: string): Array<{ sessionId: string; frame: string }> {
    return this.events
      .filter((e) => e.event === 'zen.frame')
      .map((e) => e.payload as unknown as { sessionId: string; frame: string })
      .filter((p) => p.sessionId === sessionId);
  }

  close(): void {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/** Let a broadcast or a socket close reach the server and settle. */
async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface ZenSessionCard {
  id: string;
  name: string;
  startedAt: string;
  frameCount: number;
  viewerCount: number;
}

async function listSessions(port: number): Promise<ZenSessionCard[]> {
  const { result, error } = await httpRpc(port, 'zen.sessions');
  expect(error).toBeUndefined();
  return (result as unknown as { sessions: ZenSessionCard[] }).sessions;
}

describe('zen RPC contract, against the wired gateway', () => {
  it('zen.sessions is registered and returns the { sessions } shape zen.ts destructures', async () => {
    const port = await startServer();

    const { result, error } = await httpRpc(port, 'zen.sessions');

    expect(error).toBeUndefined();
    // `zen.ts` does `result.sessions ?? []`; an array is what it maps over.
    expect(Array.isArray((result as unknown as { sessions: unknown }).sessions)).toBe(true);
    expect((result as unknown as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('lists a session a connected producer published, with the fields the card renders', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);

    await producer.call('zen.publish', {
      sessionId: 'bar-pong',
      name: 'Pong — You vs AI',
      frame: 'frame one',
    });

    const [session, ...rest] = await listSessions(port);
    expect(rest).toEqual([]);
    expect(session.id).toBe('bar-pong');
    expect(session.name).toBe('Pong — You vs AI');
    expect(session.frameCount).toBe(1);
    expect(session.viewerCount).toBe(0);
    expect(Number.isNaN(Date.parse(session.startedAt))).toBe(false);
    // The card renders five fields; a screenful of ANSI per entry is not one.
    expect(session).not.toHaveProperty('lastFrame');
  });

  it('zen.subscribe returns { subscribed, lastFrame } and then streams zen.frame events', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'caught-up' });

    const viewer = await TestClient.connect(port);
    const subscription = await viewer.call<{ subscribed: boolean; lastFrame?: string }>(
      'zen.subscribe',
      { sessionId: 'bar-pong' },
    );

    // zen.ts gates everything on `result.subscribed` and paints `lastFrame`.
    expect(subscription.subscribed).toBe(true);
    expect(subscription.lastFrame).toBe('caught-up');

    await producer.call('zen.publish', { sessionId: 'bar-pong', frame: 'live-frame' });
    await settle();

    // zen.ts's handler reads payload.sessionId and payload.frame.
    expect(viewer.framesFor('bar-pong')).toEqual([
      { sessionId: 'bar-pong', frame: 'live-frame', frameNumber: 2 },
    ]);
  });

  it('sends frames only to subscribers, not to every connection', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'f1' });

    const viewer = await TestClient.connect(port);
    const bystander = await TestClient.connect(port);
    await viewer.call('zen.subscribe', { sessionId: 'bar-pong' });

    await producer.call('zen.publish', { sessionId: 'bar-pong', frame: 'f2' });
    await settle();

    expect(viewer.framesFor('bar-pong')).toHaveLength(1);
    expect(bystander.framesFor('bar-pong')).toHaveLength(0);
  });

  it('zen.unsubscribe releases the viewer slot and stops the frames', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'f1' });
    const viewer = await TestClient.connect(port);
    await viewer.call('zen.subscribe', { sessionId: 'bar-pong' });
    expect((await listSessions(port))[0].viewerCount).toBe(1);

    const result = await viewer.call<{ unsubscribed: boolean }>('zen.unsubscribe', {
      sessionId: 'bar-pong',
    });

    expect(result.unsubscribed).toBe(true);
    // Releasing means the slot is gone, not merely that the call said ok.
    expect((await listSessions(port))[0].viewerCount).toBe(0);

    await producer.call('zen.publish', { sessionId: 'bar-pong', frame: 'after-unsub' });
    await settle();
    expect(viewer.framesFor('bar-pong')).toHaveLength(0);
  });

  it('a viewer that disconnects without unsubscribing does not leak a viewer slot', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'f1' });
    const viewer = await TestClient.connect(port);
    await viewer.call('zen.subscribe', { sessionId: 'bar-pong' });
    expect((await listSessions(port))[0].viewerCount).toBe(1);

    viewer.close();
    await settle();

    expect((await listSessions(port))[0].viewerCount).toBe(0);
  });

  it('a producer that disconnects ends its session instead of stranding it', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    const watcher = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'f1' });
    expect(await listSessions(port)).toHaveLength(1);

    producer.close();
    await settle();

    expect(await listSessions(port)).toEqual([]);
    expect(watcher.events.filter((e) => e.event === 'zen.session.end')).toEqual([
      { event: 'zen.session.end', payload: { id: 'bar-pong' } },
    ]);
  });

  it('refuses to subscribe to a session that does not exist instead of reporting success', async () => {
    const port = await startServer();
    const viewer = await TestClient.connect(port);

    await expect(viewer.call('zen.subscribe', { sessionId: 'ghost' })).rejects.toThrow(
      /Unknown zen session: ghost/,
    );
    await expect(viewer.call('zen.lastframe', { sessionId: 'ghost' })).rejects.toThrow(
      /Unknown zen session: ghost/,
    );
  });

  it('tells an HTTP caller it is not streaming rather than claiming a subscription', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);
    await producer.call('zen.publish', { sessionId: 'bar-pong', name: 'Pong', frame: 'only-frame' });

    const { result } = await httpRpc(port, 'zen.subscribe', { sessionId: 'bar-pong' });

    // HTTP has no channel for zen.frame events, so `subscribed: true` would be
    // a success report over nothing.
    expect(result?.subscribed).toBe(false);
    expect(String(result?.reason)).toMatch(/WebSocket/);
    expect(result?.lastFrame).toBe('only-frame');
    // …and the honest fallback it points at works.
    const { result: last } = await httpRpc(port, 'zen.lastframe', { sessionId: 'bar-pong' });
    expect(last?.frame).toBe('only-frame');
    // No viewer was counted for a caller that cannot receive frames.
    expect((await listSessions(port))[0].viewerCount).toBe(0);
  });

  it('rejects publishing from a connection the gateway cannot outlive-check', async () => {
    const port = await startServer();

    const { error } = await httpRpc(port, 'zen.publish', { sessionId: 'x', frame: 'y' });

    expect(error?.message).toMatch(/WebSocket/);
    expect(await listSessions(port)).toEqual([]);
  });

  it('requires sessionId and frame instead of inventing them', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);

    await expect(producer.call('zen.subscribe', {})).rejects.toThrow(/sessionId required/);
    await expect(producer.call('zen.publish', { frame: 'f' })).rejects.toThrow(/sessionId required/);
    await expect(producer.call('zen.publish', { sessionId: 's' })).rejects.toThrow(/frame required/);
  });

  it('caps frame size so a publisher cannot post arbitrary payloads', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);

    await expect(
      producer.call('zen.publish', { sessionId: 'huge', frame: 'x'.repeat(256 * 1024 + 1) }),
    ).rejects.toThrow(/exceeds/);
    expect(await listSessions(port)).toEqual([]);
  });

  it('streams frames past the 100/min control budget without spending it', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);

    // 30fps for four seconds is 120 frames — more than the control-plane
    // budget for a whole minute, which is why frames are accounted separately.
    for (let i = 0; i < 110; i++) {
      const ack = await producer.call<{ published: boolean; frameNumber: number }>('zen.publish', {
        sessionId: 'bar-pong',
        name: 'Pong',
        frame: `frame-${i}`,
      });
      expect(ack.published).toBe(true);
      expect(ack.frameNumber).toBe(i + 1);
    }

    // The same connection can still make ordinary calls afterwards.
    const sessions = await producer.call<{ sessions: ZenSessionCard[] }>('zen.sessions');
    expect(sessions.sessions[0].frameCount).toBe(110);
  });

  it('bounds the frame budget too — a publisher above 60fps is rate limited', async () => {
    const port = await startServer();
    const producer = await TestClient.connect(port);

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) =>
        producer.call('zen.publish', { sessionId: 'flood', name: 'Flood', frame: `f${i}` }),
      ),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/Rate limit/);
  });

  it('carries the Bar\'s pong frames end to end: publisher → gateway → viewer', async () => {
    const port = await startServer();
    // The exact client the TUI Bar uses, driving the exact publisher it uses.
    const bar = new TuiGatewayClient();
    await bar.connect(`ws://127.0.0.1:${port}`);
    const publisher = createZenPublisher({
      call: (method, params) => bar.call(method, params),
      sessionId: 'bar-pong',
      name: 'Pong — You vs AI',
      minIntervalMs: 0,
    });

    publisher.publish('\u001b[32mPONG\u001b[0m');
    await settle();

    const [card] = await listSessions(port);
    expect(card).toMatchObject({ id: 'bar-pong', name: 'Pong — You vs AI', frameCount: 1 });

    const viewer = await TestClient.connect(port);
    const subscription = await viewer.call<{ subscribed: boolean; lastFrame?: string }>(
      'zen.subscribe',
      { sessionId: 'bar-pong' },
    );
    expect(subscription.subscribed).toBe(true);
    expect(subscription.lastFrame).toBe('\u001b[32mPONG\u001b[0m');

    publisher.publish('\u001b[32mPONG 2\u001b[0m');
    await settle();
    expect(viewer.framesFor('bar-pong').map((f) => f.frame)).toEqual(['\u001b[32mPONG 2\u001b[0m']);

    // Quitting the Bar takes the session away with it.
    await publisher.end();
    expect(await listSessions(port)).toEqual([]);
    bar.disconnect();
  });
});
