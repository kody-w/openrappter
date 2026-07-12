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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { request as httpRequest } from 'http';
import { GatewayServer as RuntimeGatewayServer } from '../../gateway/server.js';
import type { GatewayConfig } from '../../gateway/types.js';
import WebSocket, { type ClientOptions } from 'ws';

let testDataDir = '';

class GatewayServer extends RuntimeGatewayServer {
  constructor(config: Partial<GatewayConfig>) {
    super({ ...config, dataDir: testDataDir });
  }
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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

function connectWs(port: number, options?: ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function rawHttpGet(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Gateway Integration', () => {
  let server: GatewayServer | null = null;

  beforeEach(() => {
    testDataDir = fs.mkdtempSync(path.join(process.cwd(), '.gateway-integration-'));
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    fs.rmSync(testDataDir, { recursive: true, force: true });
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

    it('allows the exact same browser origin without wildcard CORS', async () => {
      const port = randomPort();
      const origin = `http://127.0.0.1:${port}`;
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await fetch(`${origin}/health`, { headers: { Origin: origin } });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    });

    it('rejects a malicious browser origin before any loopback HTTP handler runs', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      let handlerCalled = false;
      server.registerMethod('protected.local', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://malicious.example',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'evil-origin',
          method: 'protected.local',
        }),
      });

      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(handlerCalled).toBe(false);
    });

    it('rejects a non-loopback Host header to prevent DNS rebinding', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const res = await rawHttpGet(port, { Host: `attacker.example:${port}` });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'Forbidden request origin' });
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

    it('rejects a malicious WebSocket Origin during the HTTP upgrade', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      await expect(connectWs(port, { origin: 'https://malicious.example' }))
        .rejects.toThrow(/Unexpected server response|WebSocket/);
      expect(server.getConnections()).toHaveLength(0);
    });

    it('rejects a malicious WebSocket Host during the HTTP upgrade', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      await expect(connectWs(port, {
        headers: { Host: `attacker.example:${port}` },
      })).rejects.toThrow(/Unexpected server response|WebSocket/);
      expect(server.getConnections()).toHaveLength(0);
    });

    it('accepts 127.0.0.1 and localhost same-origin browser WebSockets plus native clients', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const browser = await connectWs(port, { origin: `http://127.0.0.1:${port}` });
      expect((await doConnect(browser)).ok).toBe(true);
      browser.close();

      const localhostBrowser = await connectWs(port, {
        origin: `http://localhost:${port}`,
        headers: { Host: `localhost:${port}` },
      });
      expect((await doConnect(localhostBrowser)).ok).toBe(true);
      localhostBrowser.close();

      const native = await connectWs(port);
      expect((await doConnect(native)).ok).toBe(true);
      native.close();
    });

    it('requires configured authentication before binding publicly', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'all', auth: { mode: 'none' } });
      await expect(server.start()).rejects.toThrow(/auth is required/i);
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

    it('streams real agent deltas and a terminal frame over the live socket', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async (_request, stream) => {
        stream?.({ id: '', streaming: true, chunk: 'hello ', done: false });
        stream?.({ id: '', streaming: true, chunk: 'world', done: false });
        return { content: 'hello world', sessionId: 'stream-session', finishReason: 'stop' };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const id = 'stream-agent-1';
      const frames: Array<Record<string, unknown>> = [];
      const completed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('stream timeout')), 5000);
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.id !== id) return;
          frames.push(frame);
          if (frame.streaming === true && frame.done === true) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'agent',
        params: { message: 'stream this', stream: true },
      }));
      await completed;
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(frames.map((frame) => frame.chunk).filter(Boolean)).toEqual(['hello ', 'world']);
      const terminal = frames.at(-1);
      expect(terminal?.done).toBe(true);
      expect(terminal?.result).toEqual({
        content: 'hello world',
        sessionId: 'stream-session',
        finishReason: 'stop',
      });
      expect(terminal?.payload).toEqual(terminal?.result);
      expect(frames.filter((frame) => frame.done === true)).toHaveLength(1);
      expect(frames.some((frame) => frame.type === 'res')).toBe(false);
      ws.close();
    });

    it('settles provider output on done and emits one dispatcher-owned terminal frame', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async (_request, stream) => {
        stream?.({ id: '', streaming: true, chunk: 'before done', done: false });
        stream?.({ id: '', streaming: true, done: true });
        setTimeout(() => {
          stream?.({ id: '', streaming: true, chunk: 'late chunk', done: false });
        }, 10);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return {
          content: 'final result',
          sessionId: 'done-session',
          finishReason: 'stop',
        };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const id = 'stream-provider-done';
      const frames: Array<Record<string, unknown>> = [];
      const completed = new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.id !== id) return;
          frames.push(frame);
          if (frame.done === true) resolve();
        });
      });

      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'agent',
        params: { message: 'done then late', stream: true },
      }));
      await completed;
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(frames.map((frame) => frame.chunk).filter(Boolean)).toEqual(['before done']);
      expect(frames.filter((frame) => frame.done === true)).toHaveLength(1);
      expect(frames.at(-1)?.result).toMatchObject({
        content: 'final result',
        sessionId: 'done-session',
      });
      ws.close();
    });

    it('settles provider output on error and ignores all later callbacks', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async (_request, stream) => {
        stream?.({
          id: '',
          streaming: true,
          done: true,
          error: { code: -32603, message: 'provider failed' },
        });
        setTimeout(() => {
          stream?.({ id: '', streaming: true, chunk: 'late chunk', done: false });
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          content: 'must not become a second terminal',
          sessionId: 'error-session',
          finishReason: 'error',
        };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const id = 'stream-provider-error';
      const frames: Array<Record<string, unknown>> = [];
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.id === id) frames.push(frame);
      });
      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'agent',
        params: { message: 'error then late', stream: true },
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        done: true,
        error: { code: -32603, message: 'provider failed' },
      });
      ws.close();
    });

    it('makes stream timeouts terminal and suppresses late provider chunks', async () => {
      const port = randomPort();
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'none' },
        executionTimeoutMs: 20,
      });
      server.setAgentHandler((_request, stream) => new Promise((resolve) => {
        setTimeout(() => stream?.({ id: '', streaming: true, chunk: 'late chunk' }), 50);
        setTimeout(() => resolve({
          content: 'late result',
          sessionId: 'late-session',
          finishReason: 'stop',
        }), 60);
      }));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const id = 'stream-timeout-1';
      const frames: Array<Record<string, unknown>> = [];
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (frame.id === id) frames.push(frame);
      });

      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'agent',
        params: { message: 'timeout', stream: true },
      }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        id,
        streaming: true,
        done: true,
        error: { code: -32002 },
      });
      expect(frames[0].type).toBeUndefined();
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

    it('serializes an immediate restart behind an in-progress stop', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const stopping = server.stop();
      const restarting = server.start();
      await Promise.all([stopping, restarting]);

      expect(server.getStatus().running).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    });

    it('generation-fences an old chat completion across stop and restart', async () => {
      const port = randomPort();
      let releaseAgent: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'none' },
        shutdownTimeoutMs: 20,
      });
      server.setAgentHandler(async (request) => {
        markStarted?.();
        await new Promise<void>((resolve) => { releaseAgent = resolve; });
        return {
          content: 'stale assistant response',
          sessionId: request.sessionId ?? '',
          finishReason: 'stop',
        };
      });
      await server.start();

      const oldSocket = await connectWs(port);
      await doConnect(oldSocket);
      await rpc(oldSocket, 'chat.send', {
        sessionKey: 'restart-session',
        message: 'old generation',
      });
      await started;

      const stopStartedAt = Date.now();
      await server.stop();
      expect(Date.now() - stopStartedAt).toBeLessThan(500);
      await server.start();

      const currentSocket = await connectWs(port);
      await doConnect(currentSocket);
      const currentEvents: Array<Record<string, unknown>> = [];
      currentSocket.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'event') currentEvents.push(frame);
      });

      releaseAgent?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const messages = await rpc(currentSocket, 'chat.messages', {
        sessionId: 'restart-session',
      });
      expect((messages.payload as Array<{ role: string }>).map((message) => message.role))
        .toEqual(['user']);
      expect(currentEvents.some((frame) =>
        frame.event === 'chat'
        && ['final', 'error'].includes(
          ((frame.payload as Record<string, unknown>)?.state as string) ?? '',
        ))).toBe(false);

      const status = await fetch(`http://127.0.0.1:${port}/status`).then(
        (response) => response.json() as Promise<{ metrics: { activeAgentExecutions: number } }>,
      );
      expect(status.metrics.activeAgentExecutions).toBe(0);
      currentSocket.close();
    });

    it('does not let an old cron completion alter restarted metrics', async () => {
      const port = randomPort();
      let releaseCron: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      server = new GatewayServer({
        port,
        bind: 'loopback',
        auth: { mode: 'none' },
        shutdownTimeoutMs: 20,
      });
      server.setCronService({
        list: () => [],
        run: async () => {
          markStarted?.();
          await new Promise<void>((resolve) => { releaseCron = resolve; });
        },
        enable: async () => undefined,
        disable: async () => undefined,
      });
      await server.start();

      const oldSocket = await connectWs(port);
      await doConnect(oldSocket);
      oldSocket.send(JSON.stringify({
        type: 'req',
        id: 'old-cron',
        method: 'cron.run',
        params: { jobId: 'job-old' },
      }));
      await started;
      await server.stop();
      await server.start();

      releaseCron?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const status = await fetch(`http://127.0.0.1:${port}/status`).then(
        (response) => response.json() as Promise<{ metrics: { activeAgentExecutions: number; rpcRequestsTotal: number } }>,
      );
      expect(status.metrics.activeAgentExecutions).toBe(0);
      expect(status.metrics.rpcRequestsTotal).toBe(0);
    });
  });

  // ── HTTP JSON-RPC auth (fail-closed) ─────────────────────────────────

  describe('HTTP RPC auth', () => {
    async function httpRpc(port: number, method: string, params?: Record<string, unknown>, headers?: Record<string, string>) {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'h1', method, params }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      return { status: res.status, body };
    }

    it('blocks a protected HTTP call with no auth (token mode) and never invokes the handler', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const { status, body } = await httpRpc(port, 'protected.http');
      expect(status).toBe(401);
      expect((body.error as Record<string, unknown>).code).toBe(-32000);
      expect(handlerCalled).toBe(false);
    });

    it('blocks a protected HTTP call with a wrong bearer token and never invokes the handler', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const { status, body } = await httpRpc(port, 'protected.http', undefined, { Authorization: 'Bearer wrong-token' });
      expect(status).toBe(401);
      expect((body.error as Record<string, unknown>).message).toContain('requires authentication');
      expect(handlerCalled).toBe(false);
    });

    it('allows a protected HTTP call with the correct Authorization: Bearer token', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const { status, body } = await httpRpc(port, 'protected.http', undefined, { Authorization: 'Bearer tok-http' });
      expect(status).toBe(200);
      expect((body.result as Record<string, unknown>).ok).toBe(true);
      expect(handlerCalled).toBe(true);
    });

    it('rejects a wrong password sent in the JSON-RPC body auth field', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'password', password: 'secret-http' } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'h1', method: 'protected.http', auth: { password: 'wrong' } }),
      });
      expect(res.status).toBe(401);
      expect(handlerCalled).toBe(false);
    });

    it('accepts a correct password sent in the JSON-RPC body auth field', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'password', password: 'secret-http' } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'h1', method: 'protected.http', auth: { password: 'secret-http' } }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      expect((body.result as Record<string, unknown>).ok).toBe(true);
      expect(handlerCalled).toBe(true);
    });

    it('never synthesizes authenticated:true for protected methods over HTTP with no credential configured (auth mode none stays trusted, but requiresAuth is still enforced when a mode is configured)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['t1'] } });
      let receivedAuthenticated: boolean | undefined;
      server.registerMethod('protected.inspect', async (_params, conn: unknown) => {
        receivedAuthenticated = (conn as { authenticated: boolean }).authenticated;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      // No credential at all.
      const denied = await httpRpc(port, 'protected.inspect');
      expect(denied.status).toBe(401);
      expect(receivedAuthenticated).toBeUndefined();

      // Correct credential.
      const allowed = await httpRpc(port, 'protected.inspect', undefined, { Authorization: 'Bearer t1' });
      expect(allowed.status).toBe(200);
      expect(receivedAuthenticated).toBe(true);
    });

    it('preserves loopback auth-none behavior for HTTP (protected methods work with no credential)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      let handlerCalled = false;
      server.registerMethod('protected.http', async () => {
        handlerCalled = true;
        return { ok: true };
      }, { requiresAuth: true });
      await server.start();

      const { status, body } = await httpRpc(port, 'protected.http');
      expect(status).toBe(200);
      expect((body.result as Record<string, unknown>).ok).toBe(true);
      expect(handlerCalled).toBe(true);
    });

    it('allows only the explicit public HTTP RPC allowlist without credentials', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      await server.start();

      for (const method of ['ping', 'health', 'status']) {
        const { status, body } = await httpRpc(port, method);
        expect(status).toBe(200);
        expect(body.result).toBeDefined();
      }
    });

    it('does not let a replacement handler inherit a built-in public exemption', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      await server.start();

      let replacementCalled = false;
      server.registerMethod('ping', async () => {
        replacementCalled = true;
        return { replaced: true };
      }, { requiresAuth: false });

      const denied = await httpRpc(port, 'ping');
      expect(denied.status).toBe(401);
      expect(replacementCalled).toBe(false);

      const allowed = await httpRpc(
        port,
        'ping',
        undefined,
        { 'X-Gateway-Token': 'tok-http' },
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body.result).toEqual({ replaced: true });
      expect(replacementCalled).toBe(true);
    });

    it('protects sensitive HTTP method names and rejects untrusted origins even with a valid token', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['tok-http'] } });
      await server.start();

      const invoked: string[] = [];
      const sensitiveMethods = ['config.set', 'chat.delete', 'backup.restore', 'auth.remove'];
      for (const method of sensitiveMethods) {
        server.registerMethod(method, async () => {
          invoked.push(method);
          return { mutated: true };
        }, { requiresAuth: false });
      }

      for (const method of sensitiveMethods) {
        const { status, body } = await httpRpc(
          port,
          method,
          {},
          { Origin: 'https://untrusted.example' },
        );
        expect(status).toBe(403);
        expect(body.error).toBe('Forbidden request origin');
      }
      expect(invoked).toEqual([]);

      const blockedWithToken = await httpRpc(
        port,
        'config.set',
        {},
        { 'X-Gateway-Token': 'tok-http', Origin: 'https://untrusted.example' },
      );
      expect(blockedWithToken.status).toBe(403);
      expect(invoked).toEqual([]);

      const allowed = await httpRpc(
        port,
        'config.set',
        {},
        {
          'X-Gateway-Token': 'tok-http',
          Origin: `http://127.0.0.1:${port}`,
        },
      );
      expect(allowed.status).toBe(200);
      expect(invoked).toEqual(['config.set']);
    });

    it('never leaks the configured token/password in the error response', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['super-secret-token'] } });
      server.registerMethod('protected.http', async () => ({ ok: true }), { requiresAuth: true });
      await server.start();

      const { body } = await httpRpc(port, 'protected.http', undefined, { Authorization: 'Bearer wrong' });
      expect(JSON.stringify(body)).not.toContain('super-secret-token');
    });
  });

  // ── sessionKey / sessionId alias ──────────────────────────────────────

  describe('sessionKey/sessionId alias', () => {
    it('persists sessions only inside the injected gateway data directory', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const created = await rpc(ws, 'chat.session', { sessionId: 'isolated-session' });

      expect(created.ok).toBe(true);
      expect(fs.existsSync(path.join(testDataDir, 'sessions.json'))).toBe(true);
      ws.close();
    });

    it('scopes auth profiles and backups to the injected gateway data directory', async () => {
      const port = randomPort();
      fs.writeFileSync(path.join(testDataDir, 'test-state.json'), '{"isolated":true}');
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const profiles = await rpc(ws, 'auth.profiles');
      expect(profiles.payload).toEqual([]);

      const backup = await rpc(ws, 'backup.create', { reason: 'isolation-test' });
      const backupPath = (backup.payload as { path: string }).path;
      expect(backupPath.startsWith(path.join(testDataDir, 'backups'))).toBe(true);
      expect(fs.existsSync(path.join(backupPath, 'test-state.json'))).toBe(true);
      ws.close();
    });

    it('chat.messages accepts sessionId (canonical) for a session created via chat.send', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async (req) => ({ content: 'hi back', sessionId: req.sessionId ?? '', finishReason: 'stop' }));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const sendRes = await rpc(ws, 'chat.send', { sessionKey: 'alias-sess-1', message: 'hello' });
      expect(sendRes.ok).toBe(true);
      const accepted = sendRes.payload as Record<string, unknown>;
      expect(accepted.sessionKey).toBe('alias-sess-1');
      expect(accepted.sessionId).toBe('alias-sess-1');

      const msgsRes = await rpc(ws, 'chat.messages', { sessionId: 'alias-sess-1' });
      expect(msgsRes.ok).toBe(true);
      expect((msgsRes.payload as unknown[]).length).toBeGreaterThanOrEqual(1);

      ws.close();
    });

    it('chat.delete accepts sessionKey (legacy/native-client alias) for a session created via chat.session (sessionId)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const created = await rpc(ws, 'chat.session', { sessionId: 'alias-sess-2' });
      expect(created.ok).toBe(true);

      const deleted = await rpc(ws, 'chat.delete', { sessionKey: 'alias-sess-2' });
      expect(deleted.ok).toBe(true);
      expect((deleted.payload as Record<string, unknown>).deleted).toBe(true);

      ws.close();
    });

    it('chat.session accepts sessionKey as an alias for sessionId', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const created = await rpc(ws, 'chat.session', { sessionKey: 'alias-sess-3' });
      expect(created.ok).toBe(true);
      expect((created.payload as Record<string, unknown>).id).toBe('alias-sess-3');

      ws.close();
    });
  });

  // ── chat.abort ─────────────────────────────────────────────────────────

  describe('chat.abort', () => {
    it('supports the UI runId-only abort contract', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { content: 'late response', sessionId: 'abort-sess-1', finishReason: 'stop' };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const sendRes = await rpc(ws, 'chat.send', { sessionKey: 'abort-sess-1', message: 'hi' });
      expect(sendRes.ok).toBe(true);
      const runId = (sendRes.payload as Record<string, unknown>).runId as string;

      const abortRes = await rpc(ws, 'chat.abort', { runId });
      expect(abortRes.ok).toBe(true);
      expect((abortRes.payload as Record<string, unknown>).aborted).toBe(true);
      expect((abortRes.payload as Record<string, unknown>).runId).toBe(runId);

      ws.close();
    });

    it('supersedes concurrent runs in one session without overwriting runId tracking', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      const releases: Array<() => void> = [];
      server.setAgentHandler((req) => new Promise((resolve) => {
        releases.push(() => resolve({
          content: `finished ${req.message}`,
          sessionId: req.sessionId ?? '',
          finishReason: 'stop',
        }));
      }));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const events: Array<Record<string, unknown>> = [];
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'event' && frame.event === 'chat') events.push(frame.payload);
      });

      const first = await rpc(ws, 'chat.send', { sessionKey: 'shared-session', message: 'first' });
      await waitFor(() => releases.length >= 1, 'first run did not start');
      const second = await rpc(ws, 'chat.send', { sessionKey: 'shared-session', message: 'second' });
      await waitFor(() => releases.length >= 2, 'second run did not start');

      const firstRunId = (first.payload as Record<string, unknown>).runId as string;
      const secondRunId = (second.payload as Record<string, unknown>).runId as string;
      expect(firstRunId).not.toBe(secondRunId);

      const staleAbort = await rpc(ws, 'chat.abort', { runId: firstRunId });
      expect((staleAbort.payload as Record<string, unknown>).aborted).toBe(false);
      const currentAbort = await rpc(ws, 'chat.abort', { runId: secondRunId });
      expect((currentAbort.payload as Record<string, unknown>).aborted).toBe(true);

      for (const release of releases) release();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const abortedRunIds = events
        .filter((event) => event.state === 'aborted')
        .map((event) => event.runId);
      expect(abortedRunIds).toContain(firstRunId);
      expect(abortedRunIds).toContain(secondRunId);
      expect(events.some((event) => event.state === 'final')).toBe(false);
      ws.close();
    });

    it('returns aborted:false when there is no active run for the session', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const abortRes = await rpc(ws, 'chat.abort', { sessionKey: 'no-such-run' });
      expect(abortRes.ok).toBe(true);
      expect((abortRes.payload as Record<string, unknown>).aborted).toBe(false);

      ws.close();
    });

    it('cleans both runId and session indexes after a run finishes', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async (req) => ({
        content: 'done',
        sessionId: req.sessionId ?? '',
        finishReason: 'stop',
      }));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const finalEvent = new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'event' && frame.event === 'chat' && frame.payload?.state === 'final') {
            resolve();
          }
        });
      });

      const sent = await rpc(ws, 'chat.send', { sessionKey: 'finished-session', message: 'hi' });
      const runId = (sent.payload as Record<string, unknown>).runId as string;
      await finalEvent;

      const byRunId = await rpc(ws, 'chat.abort', { runId });
      expect((byRunId.payload as Record<string, unknown>).aborted).toBe(false);
      const bySession = await rpc(ws, 'chat.abort', { sessionKey: 'finished-session' });
      expect((bySession.payload as Record<string, unknown>).aborted).toBe(false);
      ws.close();
    });

    it('does not broadcast an error when an aborted run later rejects', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setAgentHandler(async () => {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error('late failure after user abort');
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const states: string[] = [];
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'event' && frame.event === 'chat' && frame.payload?.state) {
          states.push(frame.payload.state);
        }
      });

      await rpc(ws, 'chat.send', { sessionKey: 'abort-sess-2', message: 'hi' });
      const abortRes = await rpc(ws, 'chat.abort', { sessionKey: 'abort-sess-2' });
      expect(abortRes.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));

      expect(states).toContain('aborted');
      expect(states).not.toContain('error');
      ws.close();
    });
  });
});
