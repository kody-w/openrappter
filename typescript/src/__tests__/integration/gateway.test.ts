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

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.version).toBeDefined();
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should respond to GET /status', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/status`);
      const body = (await res.json()) as Record<string, unknown>;
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

    it('should reject wrong token', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'token', tokens: ['correct-token'] },
      });
      await server.start();

      const ws = await connectWs(port);
      const res = await doConnect(ws, { token: 'wrong-token' });
      expect(res.ok).toBe(false);
      expect((res.error as Record<string, unknown>).message).not.toContain('correct-token');

      ws.close();
    });

    it('should keep separate clients isolated: one authenticated client does not grant access to another unauthenticated client', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'token', tokens: ['shared-token'] },
      });
      await server.start();

      const wsA = await connectWs(port);
      const connectA = await doConnect(wsA, { token: 'shared-token' });
      expect(connectA.ok).toBe(true);

      // Client A can now call methods
      const statusA = await rpc(wsA, 'status');
      expect(statusA.ok).toBe(true);

      // Client B never authenticates — it must remain blocked, regardless of A's state
      const wsB = await connectWs(port);
      const statusB = await rpc(wsB, 'status');
      expect(statusB.ok).toBe(false);
      expect((statusB.error as Record<string, unknown>).message).toContain('Handshake required');

      wsA.close();
      wsB.close();
    });

    it('should not leak authenticated state across reconnects', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'token', tokens: ['reconnect-token'] },
      });
      await server.start();

      const ws1 = await connectWs(port);
      await doConnect(ws1, { token: 'reconnect-token' });
      ws1.close();
      await new Promise((r) => setTimeout(r, 50));

      // A brand-new connection must start unauthenticated even though a
      // previous connection from the same process/token succeeded.
      const ws2 = await connectWs(port);
      const res = await rpc(ws2, 'status');
      expect(res.ok).toBe(false);
      expect((res.error as Record<string, unknown>).message).toContain('Handshake required');

      ws2.close();
    });
  });

  // ── requiresAuth dispatch enforcement ──────────────────────────────────

  describe('requiresAuth dispatch enforcement', () => {
    it('should let an authenticated client call a requiresAuth-protected method', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-1'] } });
      let handlerCalled = false;
      server.registerMethod('protected.action', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws, { token: 'tok-1' });

      const res = await rpc(ws, 'protected.action');
      expect(res.ok).toBe(true);
      expect(handlerCalled).toBe(true);

      ws.close();
    });

    it('should let public (non-requiresAuth) methods remain callable after handshake', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-2'] } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws, { token: 'tok-2' });

      const res = await rpc(ws, 'health');
      expect(res.ok).toBe(true);

      ws.close();
    });

    it('should work with requiresAuth methods when auth mode is "none" (local trusted mode)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      let handlerCalled = false;
      server.registerMethod('protected.action', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const res = await rpc(ws, 'protected.action');
      expect(res.ok).toBe(true);
      expect(handlerCalled).toBe(true);

      ws.close();
    });

    it('should reject an unauthenticated caller of a requiresAuth method and never invoke the handler (regression guard for dead requiresAuth flag)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-3'] } });
      let handlerCalled = false;
      server.registerMethod('protected.dangerous', async () => {
        handlerCalled = true;
        return { didSomethingDangerous: true };
      }, { requiresAuth: true });
      await server.start();

      // Access the private dispatch path directly. This deliberately bypasses
      // the connect-handshake gate (which today already blocks everything
      // pre-auth) so this test exercises ONLY the per-method `requiresAuth`
      // enforcement inside dispatchMethod. If a future change makes the
      // `requiresAuth` flag dead code again (e.g. dispatch stops checking
      // `info.authenticated`), this test fails because handlerCalled becomes
      // true and the response comes back ok.
      const internal = server as unknown as {
        connections: Map<string, { ws: WebSocket; info: { authenticated: boolean } }>;
        dispatchMethod: (
          connId: string,
          ws: WebSocket,
          info: { authenticated: boolean },
          frame: { type: 'req'; id: string; method: string; params?: Record<string, unknown> }
        ) => Promise<void>;
      };

      const clientWs = await connectWs(port);
      // Do NOT send a valid connect handshake — leave the connection unauthenticated.
      await new Promise((r) => setTimeout(r, 50));

      const [connId, conn] = Array.from(internal.connections.entries())[0];
      expect(conn.info.authenticated).toBe(false);

      const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
        clientWs.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.id === 'direct-1') resolve(msg);
        });
      });

      // Use the server's own per-connection `ws` (conn.ws) — not the test's
      // client-side socket — so the response is actually sent to the client
      // rather than looping a bogus "message" back into the server itself.
      await internal.dispatchMethod(connId, conn.ws, conn.info, {
        type: 'req',
        id: 'direct-1',
        method: 'protected.dangerous',
        params: {},
      });

      const res = await responsePromise;
      expect(res.ok).toBe(false);
      expect((res.error as Record<string, unknown>).code).toBe(-32000);
      expect((res.error as Record<string, unknown>).message).toContain('requires authentication');
      expect(handlerCalled).toBe(false);

      clientWs.close();
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
