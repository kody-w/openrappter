import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { GatewayServer as RuntimeGatewayServer } from '../../gateway/server.js';
import type { GatewayConfig } from '../../gateway/types.js';

/**
 * The channels screen updates when a channel connects or disconnects.
 *
 * `channels.ts` has always listened for `channel.status` and kept a map of
 * statuses keyed by type. Nothing ever emitted that event, so the map was
 * seeded once by `channels.list` and then froze: connecting or disconnecting a
 * channel left the screen showing the previous state until someone reloaded.
 * The listener was real, the feature was not.
 *
 * These drive a real socket rather than asserting the emit call, because the
 * failure this fixes lived precisely between two halves that each looked
 * correct — a listener with no emitter. A test that stubbed either side would
 * have reproduced the original blind spot rather than closing it.
 */

let testDataDir = '';

class GatewayServer extends RuntimeGatewayServer {
  constructor(config: Partial<GatewayConfig>) {
    super({ ...config, dataDir: testDataDir });
  }
}

function rpc(
  ws: WebSocket,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Resolve with the first `channel.status` event frame, or null if none arrives. */
function nextChannelStatus(ws: WebSocket, ms = 1500): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(null);
    }, ms);
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'event' && msg.event === 'channel.status') {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg.payload as Record<string, unknown>);
      }
    };
    ws.on('message', handler);
  });
}

/** A registry with one connectable channel, as the server consumes it. */
function fakeRegistry(): {
  registry: Record<string, unknown>;
  connected: () => boolean;
} {
  let connected = false;
  return {
    connected: () => connected,
    registry: {
      getStatusList: () => [
        { id: 'slack-main', type: 'slack', connected, configured: true },
        { id: 'discord-main', type: 'discord', connected: false, configured: true },
      ],
      connectChannel: async (type: string) => {
        if (type === 'slack') connected = true;
      },
      disconnectChannel: async (type: string) => {
        if (type === 'slack') connected = false;
      },
    },
  };
}

describe('channel.status reaches subscribers', () => {
  let server: GatewayServer | null = null;
  let socket: WebSocket | null = null;

  beforeEach(() => {
    testDataDir = fs.mkdtempSync(path.join(process.cwd(), '.channel-status-'));
  });

  afterEach(async () => {
    if (socket) { socket.close(); socket = null; }
    if (server) { await server.stop(); server = null; }
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  async function startWithRegistry(): Promise<{ port: number; connected: () => boolean }> {
    const { registry, connected } = fakeRegistry();
    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
    (server as unknown as { channelRegistry: unknown }).channelRegistry = registry;
    await server.start();
    const port = server.port;
    return { port, connected };
  }

  async function subscribedSocket(port: number): Promise<WebSocket> {
    const ws = await connectWs(port);
    await rpc(ws, 'connect', {
      client: { id: 'channel-status-test', version: '1.0.0', platform: 'node', mode: 'test' },
    });
    await rpc(ws, 'subscribe', { events: ['channel.status'] });
    return ws;
  }

  it('connecting a channel notifies a subscriber', async () => {
    const { port } = await startWithRegistry();
    socket = await subscribedSocket(port);

    const received = nextChannelStatus(socket);
    await rpc(socket, 'channels.connect', { type: 'slack' });

    expect(await received).toMatchObject({ type: 'slack', connected: true });
  });

  it('disconnecting a channel notifies a subscriber', async () => {
    const { port } = await startWithRegistry();
    socket = await subscribedSocket(port);

    await rpc(socket, 'channels.connect', { type: 'slack' });
    const received = nextChannelStatus(socket);
    await rpc(socket, 'channels.disconnect', { type: 'slack' });

    expect(await received).toMatchObject({ type: 'slack', connected: false });
  });

  it('sends the same shape channels.list returns, so one type renders both', async () => {
    const { port } = await startWithRegistry();
    socket = await subscribedSocket(port);

    const received = nextChannelStatus(socket);
    await rpc(socket, 'channels.connect', { type: 'slack' });
    const event = await received;

    const list = (await rpc(socket, 'channels.list')).payload as Record<string, unknown>[];
    const listed = list.find((entry) => entry.type === 'slack');

    expect(event).toEqual(listed);
  });

  it('reports only the channel that changed', async () => {
    // Broadcasting every channel on every change would make the screen redraw
    // rows nothing happened to, and would hide which one actually moved.
    const { port } = await startWithRegistry();
    socket = await subscribedSocket(port);

    const received = nextChannelStatus(socket);
    await rpc(socket, 'channels.connect', { type: 'slack' });

    expect((await received)?.type).toBe('slack');
  });

  it('stays silent for a channel the registry does not know', async () => {
    const { port } = await startWithRegistry();
    socket = await subscribedSocket(port);

    const received = nextChannelStatus(socket, 600);
    await rpc(socket, 'channels.connect', { type: 'nonexistent' });

    expect(await received).toBeNull();
  });
});
