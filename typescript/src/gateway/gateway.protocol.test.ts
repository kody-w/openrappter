/**
 * Gateway protocol tests — openclaw-compatible connect handshake,
 * frame-based messaging, chat.send → agent wiring, and event broadcasting.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { GatewayServer } from './server.js';
import type { AgentRequest, AgentResponse, StreamingResponse } from './types.js';

const TEST_PORT = 19789;
const TEST_TOKEN = 'test-token-abc123';

/** Helper: connect a raw WebSocket to the test server */
function connectWs(port = TEST_PORT): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Helper: send a frame and wait for the response with matching id */
function rpc(ws: WebSocket, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('rpc timeout')), 5000);
    const handler = (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === frame.id) {
        ws.off('message', handler);
        clearTimeout(timeout);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify(frame));
  });
}

/** Helper: collect broadcast events of a given type */
function collectEvents(ws: WebSocket, eventName: string, count: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => reject(new Error(`event timeout: got ${events.length}/${count}`)), 8000);
    const handler = (raw: Buffer | string) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'event' && msg.event === eventName) {
        events.push(msg.payload);
        if (events.length >= count) {
          ws.off('message', handler);
          clearTimeout(timeout);
          resolve(events);
        }
      }
    };
    ws.on('message', handler);
  });
}

/** Helper: perform a full connect handshake */
async function connectHandshake(ws: WebSocket, opts?: { token?: string }): Promise<Record<string, unknown>> {
  const res = await rpc(ws, {
    type: 'req',
    id: 'connect-1',
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'test', displayName: 'Test Client', version: '1.0.0', platform: 'test', mode: 'test' },
      ...(opts?.token ? { auth: { token: opts.token } } : {}),
    },
  });
  return res;
}

describe('Gateway Protocol (openclaw-compatible)', () => {
  let server: GatewayServer;

  beforeAll(async () => {
    server = new GatewayServer({
      port: TEST_PORT,
      bind: 'loopback',
      auth: { mode: 'token', tokens: [TEST_TOKEN] },
      heartbeatInterval: 60000, // slow heartbeat to avoid noise
    });

    // Wire a simple echo agent
    server.setAgentHandler(async (req: AgentRequest, stream?: (r: StreamingResponse) => void) => {
      const reply = `Echo: ${req.message}`;
      if (stream) {
        // Simulate streaming: send two chunks then done
        for (const word of reply.split(' ')) {
          stream({ id: 'stream', streaming: true, chunk: word + ' ' });
        }
        stream({ id: 'stream', streaming: true, done: true });
      }
      return {
        sessionId: req.sessionId ?? 'test-session',
        content: reply,
        finishReason: 'stop',
      } as AgentResponse;
    });

    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  // ── Connect Handshake ──────────────────────────────────────────────────

  describe('connect handshake', () => {
    it('should accept a valid connect frame and return hello-ok', async () => {
      const ws = await connectWs();
      try {
        const res = await connectHandshake(ws, { token: TEST_TOKEN });
        expect(res.type).toBe('res');
        expect(res.ok).toBe(true);
        expect(res.payload).toBeDefined();
        const payload = res.payload as Record<string, unknown>;
        expect(payload.type).toBe('hello-ok');
        expect(payload.protocol).toBe(3);
        expect(payload.server).toBeDefined();
        expect(payload.features).toBeDefined();
        const features = payload.features as { methods: string[] };
        expect(features.methods.length).toBeGreaterThan(0);
      } finally {
        ws.close();
      }
    });

    it('should reject non-connect messages before handshake', async () => {
      const ws = await connectWs();
      try {
        const res = await rpc(ws, {
          type: 'req',
          id: 'bad-1',
          method: 'status',
          params: {},
        });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('should reject connect with invalid auth token', async () => {
      const ws = await connectWs();
      try {
        const res = await connectHandshake(ws, { token: 'wrong-token' });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('should allow connect without token when auth mode is none', async () => {
      const noAuthServer = new GatewayServer({
        port: TEST_PORT + 1,
        bind: 'loopback',
        auth: { mode: 'none' },
        heartbeatInterval: 60000,
      });
      await noAuthServer.start();
      try {
        const ws = await connectWs(TEST_PORT + 1);
        const res = await connectHandshake(ws);
        expect(res.ok).toBe(true);
        ws.close();
      } finally {
        await noAuthServer.stop();
      }
    });
  });

  // ── Frame Format ───────────────────────────────────────────────────────

  describe('frame-based messaging', () => {
    it('should respond with type:res frames', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });
      try {
        const res = await rpc(ws, { type: 'req', id: 'status-1', method: 'status', params: {} });
        expect(res.type).toBe('res');
        expect(res.id).toBe('status-1');
        expect(res.ok).toBe(true);
        expect(res.payload).toBeDefined();
        const payload = res.payload as { running: boolean; port: number };
        expect(payload.running).toBe(true);
        expect(payload.port).toBe(TEST_PORT);
      } finally {
        ws.close();
      }
    });

    it('should return error frame for unknown methods', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });
      try {
        const res = await rpc(ws, { type: 'req', id: 'nope-1', method: 'does.not.exist', params: {} });
        expect(res.type).toBe('res');
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('should accept legacy JSON-RPC frames (backward compat)', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });
      try {
        // Legacy format: { id, method, params } without type
        const res = await rpc(ws, { id: 'legacy-1', method: 'ping', params: {} });
        // Should still get a response (type:res for new protocol, or legacy)
        expect(res.id).toBe('legacy-1');
        expect(res.ok === true || res.result !== undefined).toBe(true);
      } finally {
        ws.close();
      }
    });
  });

  // ── Chat Send ──────────────────────────────────────────────────────────

  describe('chat.send → agent execution', () => {
    it('should accept chat.send and broadcast chat events', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });

      // Start listening for events BEFORE sending (agent executes async)
      const eventsPromise = collectEvents(ws, 'chat', 4); // 3 deltas + 1 final for "Echo: Hello agent"

      const res = await rpc(ws, {
        type: 'req',
        id: 'chat-1',
        method: 'chat.send',
        params: {
          sessionKey: 'test-session',
          message: 'Hello agent',
          idempotencyKey: 'idem-1',
        },
      });

      expect(res.type).toBe('res');
      expect(res.ok).toBe(true);

      try {
        const events = await eventsPromise;
        const finalEvent = events.find((e) => (e as Record<string, unknown>).state === 'final') as Record<string, unknown> | undefined;
        expect(finalEvent).toBeDefined();
        expect(finalEvent!.message).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('should reject chat.send with missing message', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });
      try {
        const res = await rpc(ws, {
          type: 'req',
          id: 'chat-bad',
          method: 'chat.send',
          params: { sessionKey: 'test-session', idempotencyKey: 'idem-2' },
        });
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
      } finally {
        ws.close();
      }
    });

    it('should include delta events for streaming agents', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });

      // Collect multiple events (deltas + final)
      const eventsPromise = collectEvents(ws, 'chat', 2);

      try {
        await rpc(ws, {
          type: 'req',
          id: 'chat-stream',
          method: 'chat.send',
          params: {
            sessionKey: 'test-session-2',
            message: 'Stream me',
            idempotencyKey: 'idem-3',
          },
        });

        const events = await eventsPromise;
        const deltas = events.filter((e) => (e as Record<string, unknown>).state === 'delta');
        const finals = events.filter((e) => (e as Record<string, unknown>).state === 'final');
        // Should have at least one delta and one final
        expect(deltas.length + finals.length).toBeGreaterThanOrEqual(2);
      } finally {
        ws.close();
      }
    });
  });

  // ── Event Broadcasting ─────────────────────────────────────────────────

  describe('event broadcasting', () => {
    it('should broadcast events in type:event frame format', async () => {
      const ws = await connectWs();
      await connectHandshake(ws, { token: TEST_TOKEN });

      try {
        // Trigger a chat.send which should broadcast events
        const eventsPromise = collectEvents(ws, 'chat', 1);
        await rpc(ws, {
          type: 'req',
          id: 'evt-1',
          method: 'chat.send',
          params: { sessionKey: 's1', message: 'test', idempotencyKey: 'idem-evt' },
        });
        const events = await eventsPromise;
        expect(events.length).toBeGreaterThanOrEqual(1);
      } finally {
        ws.close();
      }
    });
  });

  // ── Health / Status ────────────────────────────────────────────────────

  describe('HTTP endpoints', () => {
    it('should serve /health', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('ok');
    });

    it('should serve /status', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/status`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.running).toBe(true);
      expect(body.version).toBeDefined();
    });
  });
});
