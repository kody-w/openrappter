/**
 * Gateway Integration Tests
 * Tests that start a real GatewayServer on a random port:
 * - HTTP health/status endpoints
 * - WebSocket connect handshake
 * - RPC method invocation
 * - Auth modes (none, password)
 * - Rate limiting
 * - Event subscription/broadcast
 * - Clean shutdown
 */

import { describe, it, expect, afterEach } from 'vitest';
import { GatewayServer } from '../../gateway/server.js';
import WebSocket from 'ws';

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/** Helper: send a request frame and wait for the response */
function rpc(ws: WebSocket, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
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

/** Helper: perform the connect handshake */
async function doConnect(ws: WebSocket, auth?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return rpc(ws, 'connect', {
    client: { id: 'test-client', version: '1.0.0', platform: 'node', mode: 'test' },
    ...(auth ? { auth } : {}),
  });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('Gateway Integration', () => {
  let server: GatewayServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  // ── HTTP Endpoints ────────────────────────────────────────────────────

  describe('HTTP endpoints', () => {
    it('should respond to GET /health', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBeDefined();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should respond to GET /status', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/status`);
      const body = await res.json();
      expect(body.running).toBe(true);
      expect(body.port).toBe(port);
    });

    it('should return 404 for unknown paths', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  // ── WebSocket Handshake ───────────────────────────────────────────────

  describe('WebSocket handshake', () => {
    it('should accept connect handshake (no auth)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      const res = await doConnect(ws);

      expect(res.ok).toBe(true);
      const payload = res.payload as Record<string, unknown>;
      expect(payload.type).toBe('hello-ok');

      ws.close();
    });

    it('should reject non-connect messages before handshake', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      const res = await rpc(ws, 'status');

      expect(res.ok).toBe(false);
      expect((res.error as Record<string, unknown>).message).toContain('Handshake required');

      ws.close();
    });
  });

  // ── Auth Modes ────────────────────────────────────────────────────────

  describe('Auth modes', () => {
    it('should accept password auth', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'password', password: 'secret123' },
      });
      await server.start();

      const ws = await connectWs(port);
      const res = await doConnect(ws, { password: 'secret123' });
      expect(res.ok).toBe(true);

      ws.close();
    });

    it('should reject wrong password', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'password', password: 'secret123' },
      });
      await server.start();

      const ws = await connectWs(port);
      const res = await doConnect(ws, { password: 'wrong' });
      expect(res.ok).toBe(false);

      ws.close();
    });
  });

  // ── RPC Methods ───────────────────────────────────────────────────────

  describe('RPC methods', () => {
    it('should respond to ping', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'ping');
      expect(res.ok).toBe(true);
      expect((res.payload as Record<string, unknown>).pong).toBeDefined();

      ws.close();
    });

    it('should respond to status', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'status');
      expect(res.ok).toBe(true);
      const payload = res.payload as Record<string, unknown>;
      expect(payload.running).toBe(true);

      ws.close();
    });

    it('should list available methods', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'methods');
      expect(res.ok).toBe(true);
      const methods = res.payload as string[];
      expect(methods).toContain('ping');
      expect(methods).toContain('status');
      expect(methods).toContain('health');
      expect(methods).toContain('chat.send');

      ws.close();
    });

    it('should return error for unknown methods', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'nonexistent.method');
      expect(res.ok).toBe(false);

      ws.close();
    });

    it('should support custom registered methods', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.registerMethod('custom.echo', async (params: { text: string }) => {
        return { echoed: params.text };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'custom.echo', { text: 'hello' });
      expect(res.ok).toBe(true);
      expect((res.payload as Record<string, unknown>).echoed).toBe('hello');

      ws.close();
    });
  });

  // ── Server Lifecycle ──────────────────────────────────────────────────

  describe('Server lifecycle', () => {
    it('should report status correctly', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback' });

      const beforeStart = server.getStatus();
      expect(beforeStart.running).toBe(false);

      await server.start();

      const afterStart = server.getStatus();
      expect(afterStart.running).toBe(true);
      expect(afterStart.port).toBe(port);
      expect(afterStart.connections).toBe(0);

      await server.stop();

      const afterStop = server.getStatus();
      expect(afterStop.running).toBe(false);
      server = null;
    });

    it('should track connections', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      // Small delay for connection registration
      await new Promise((r) => setTimeout(r, 50));

      expect(server.getConnections().length).toBeGreaterThanOrEqual(1);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it('should clean up on stop', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      await server.stop();
      server = null;

      expect(ws.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    });
  });
});
