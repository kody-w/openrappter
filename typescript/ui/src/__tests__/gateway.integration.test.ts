// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { GatewayServer } from '../../../src/gateway/server.js';
import {
  GatewayClient,
  gatewayUrlFromLocation,
  type WebSocketCtor,
} from '../services/gateway.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for gateway state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('production UI gateway origin integration', () => {
  let server: GatewayServer | null = null;
  let dataDir = '';

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(process.cwd(), '.ui-gateway-integration-'));
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('connects from 127.0.0.1 and localhost while rejecting an evil origin', async () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    server = new GatewayServer({
      port,
      bind: 'loopback',
      auth: { mode: 'none' },
      dataDir,
    });
    await server.start();

    for (const hostname of ['127.0.0.1', 'localhost']) {
      const origin = `http://${hostname}:${port}`;
      const BrowserWebSocket = class extends WebSocket {
        constructor(url: string) {
          super(url, { origin, family: 4 });
        }
      } as unknown as WebSocketCtor;
      const client = new GatewayClient({
        url: gatewayUrlFromLocation({ protocol: 'http:', host: `${hostname}:${port}` }),
        webSocketImpl: BrowserWebSocket,
        maxReconnectAttempts: 0,
      });

      await client.connect();
      expect(client.isConnected).toBe(true);
      client.disconnect();
    }
    await waitFor(() => server!.getConnections().length === 0);

    const EvilWebSocket = class extends WebSocket {
      constructor(url: string) {
        super(url, { origin: 'https://evil.example', family: 4 });
      }
    } as unknown as WebSocketCtor;
    const evil = new GatewayClient({
      url: gatewayUrlFromLocation({ protocol: 'http:', host: `127.0.0.1:${port}` }),
      webSocketImpl: EvilWebSocket,
      maxReconnectAttempts: 0,
    });
    await expect(evil.connect()).rejects.toThrow();
    expect(server.getConnections()).toHaveLength(0);
    evil.disconnect();
  });
});
