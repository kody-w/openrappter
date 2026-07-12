/**
 * Tests for the GatewayClient service.
 *
 * Uses a deterministic injectable MockWebSocket (passed via
 * `webSocketImpl`, not a global monkey-patch) that automatically answers
 * the `connect` handshake — mirroring `GatewayServer.handleConnect` — so
 * every test can `await client.connect()` without manually simulating a
 * hello-ok frame. Non-handshake requests/events are still driven
 * explicitly via `ws.simulateMessage()` for full control.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient, gatewayUrlFromLocation } from '../services/gateway.js';
import type { WebSocketLike } from '../services/gateway.js';

// --- Deterministic mock WebSocket ---

let mockInstances: MockWebSocket[] = [];

class MockWebSocket implements WebSocketLike {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static autoOpen = true;
  static autoHandshake = true;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  sent: string[] = [];
  /** When set, the auto-handshake responder validates the connect frame's
   * `auth` credential against this before answering ok/error — mirrors
   * `GatewayServer.isAuthCredentialValid`. */
  requiredAuth: { token?: string; password?: string } | null = null;

  constructor(public url: string) {
    mockInstances.push(this);
    // Auto-open on next microtask so handlers are set first
    Promise.resolve().then(() => {
      if (!MockWebSocket.autoOpen || this.readyState !== MockWebSocket.CONNECTING) return;
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
    const frame = JSON.parse(data);
    if (
      MockWebSocket.autoHandshake
      && frame.type === 'req'
      && frame.method === 'connect'
    ) {
      Promise.resolve().then(() => this.autoAnswerConnect(frame));
    }
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  private autoAnswerConnect(frame: { id: string; params?: { auth?: { token?: string; password?: string } } }) {
    const auth = frame.params?.auth;
    let ok = true;
    let message = '';
    if (this.requiredAuth?.password !== undefined) {
      ok = auth?.password === this.requiredAuth.password;
      message = 'Invalid or missing password';
    } else if (this.requiredAuth?.token !== undefined) {
      ok = auth?.token === this.requiredAuth.token;
      message = 'Invalid or missing auth token';
    }

    this.onmessage?.({
      data: JSON.stringify(ok
        ? {
          type: 'res', id: frame.id, ok: true,
          payload: {
            type: 'hello-ok',
            server: { version: '1.0.0', host: 'localhost', connId: 'conn_test' },
            features: { methods: [], events: [] },
            policy: {},
          },
        }
        : { type: 'res', id: frame.id, ok: false, error: { code: -32000, message } }),
    });
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  mockInstances = [];
  MockWebSocket.autoOpen = true;
  MockWebSocket.autoHandshake = true;
});

afterEach(() => {
  vi.useRealTimers();
});

function getMockWs(): MockWebSocket {
  return mockInstances[mockInstances.length - 1];
}

/** The most recently sent frame on a socket, parsed. */
function lastSent(ws: MockWebSocket): any {
  return JSON.parse(ws.sent[ws.sent.length - 1]);
}

describe('GatewayClient', () => {
  it('derives production WebSocket URLs from the page origin', () => {
    expect(gatewayUrlFromLocation({
      protocol: 'http:',
      host: '127.0.0.1:18790',
    })).toBe('ws://127.0.0.1:18790');
    expect(gatewayUrlFromLocation({
      protocol: 'https:',
      host: 'localhost:18790',
    })).toBe('wss://localhost:18790');
  });

  it('uses the same-origin Vite WebSocket proxy path in development', () => {
    expect(gatewayUrlFromLocation({
      protocol: 'http:',
      host: 'localhost:3000',
    }, '/gateway')).toBe('ws://localhost:3000/gateway');
  });

  it('does not invent a localhost URL outside a browser', () => {
    expect(gatewayUrlFromLocation({ protocol: '', host: '' })).toBe('');
  });

  it('connects and resolves', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    expect(client.isConnected).toBe(true);
  });

  it('sends the connect handshake frame with client info', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    expect(ws.sent).toHaveLength(1);
    const req = lastSent(ws);
    expect(req.type).toBe('req');
    expect(req.method).toBe('connect');
    expect(req.params.client.id).toBe('openrappter-ui');
  });

  it('sends RPC requests and receives responses', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.call<{ pong: number }>('ping');

    const req = lastSent(ws);
    expect(req.method).toBe('ping');

    ws.simulateMessage({ type: 'res', id: req.id, ok: true, payload: { pong: 123 } });

    const result = await promise;
    expect(result.pong).toBe(123);
  });

  it('rejects RPC on error response', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.call('bad.method');
    const req = lastSent(ws);
    ws.simulateMessage({
      type: 'res', id: req.id, ok: false,
      error: { code: -32601, message: 'Method not found' },
    });

    await expect(promise).rejects.toThrow('Method not found');
  });

  it('rejects call when not connected', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await expect(client.call('test')).rejects.toThrow('Not connected');
  });

  it('rejects requests that exceed their timeout', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      requestTimeoutMs: 20,
    });
    await client.connect();

    await expect(client.call('slow.method')).rejects.toThrow('Request timed out');
  });

  it('dispatches events to listeners', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('heartbeat', handler);

    ws.simulateMessage({ type: 'event', event: 'heartbeat', payload: { uptime: 100 } });

    expect(handler).toHaveBeenCalledWith({ uptime: 100 });
  });

  it('dispatches wildcard events', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('*', handler);

    ws.simulateMessage({ type: 'event', event: 'chat.message', payload: { text: 'hi' } });

    expect(handler).toHaveBeenCalledWith({
      event: 'chat.message',
      payload: { text: 'hi' },
    });
  });

  it('removes event listeners with off()', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('heartbeat', handler);
    client.off('heartbeat', handler);

    ws.simulateMessage({ type: 'event', event: 'heartbeat', payload: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handles streaming responses', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const chunks: string[] = [];
    const promise = client.callStream(
      'agent',
      { message: 'hello' },
      (r) => {
        if (r.chunk) chunks.push(r.chunk);
      },
    );

    const req = lastSent(ws);
    expect(req.params.stream).toBe(true);

    // Streaming deltas intentionally omit the `type` wrapper (see StreamFrame).
    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'Hello ' });
    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'world!' });
    const finalResult = { sessionId: 'stream-session', content: 'Hello world!' };
    ws.simulateMessage({
      id: req.id,
      streaming: true,
      done: true,
      result: finalResult,
      payload: finalResult,
    });

    await expect(promise).resolves.toEqual(finalResult);
    expect(chunks).toEqual(['Hello ', 'world!']);

    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'too late' });
    expect(chunks).toEqual(['Hello ', 'world!']);
  });

  it('accepts payload as a terminal stream result compatibility alias', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.callStream('agent', { message: 'hi' }, () => {});
    const req = lastSent(ws);
    ws.simulateMessage({
      id: req.id,
      streaming: true,
      done: true,
      payload: { sessionId: 'legacy-session', content: 'legacy result' },
    });

    await expect(promise).resolves.toEqual({
      sessionId: 'legacy-session',
      content: 'legacy result',
    });
  });

  it('rejects callStream on a streaming error frame', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.callStream('agent', { message: 'hi' }, () => {});
    const req = lastSent(ws);
    ws.simulateMessage({ id: req.id, streaming: true, error: { code: -32603, message: 'boom' } });

    await expect(promise).rejects.toThrow('boom');
  });

  it('treats stream errors as terminal and ignores late chunks', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();
    const onChunk = vi.fn();

    const promise = client.callStream('agent', { message: 'hi' }, onChunk);
    const req = lastSent(ws);
    ws.simulateMessage({ id: req.id, streaming: true, error: { code: -32603, message: 'boom' } });
    await expect(promise).rejects.toThrow('boom');

    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'too late' });
    ws.simulateMessage({ id: req.id, streaming: true, done: true, result: { content: 'too late' } });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('ignores late stream frames after a timeout', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      requestTimeoutMs: 10,
    });
    await client.connect();
    const ws = getMockWs();
    const onChunk = vi.fn();

    const promise = client.callStream('agent', { message: 'hi' }, onChunk);
    const req = lastSent(ws);
    await expect(promise).rejects.toThrow('Stream idle timed out');

    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'too late' });
    ws.simulateMessage({ id: req.id, streaming: true, done: true, result: { content: 'too late' } });
    expect(onChunk).not.toHaveBeenCalled();
  });

  it('refreshes the stream idle timeout whenever activity arrives', async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      streamIdleTimeoutMs: 100,
      streamOverallTimeoutMs: 1_000,
    });
    await client.connect();
    const ws = getMockWs();
    const chunks: string[] = [];

    const promise = client.callStream<{ content: string }>(
      'agent',
      { message: 'long' },
      (frame) => {
        if (frame.chunk) chunks.push(frame.chunk);
      },
    );
    const req = lastSent(ws);

    for (const chunk of ['one', 'two', 'three']) {
      await vi.advanceTimersByTimeAsync(90);
      ws.simulateMessage({ id: req.id, streaming: true, chunk });
    }
    ws.simulateMessage({
      id: req.id,
      streaming: true,
      done: true,
      result: { content: 'done' },
    });

    await expect(promise).resolves.toEqual({ content: 'done' });
    expect(chunks).toEqual(['one', 'two', 'three']);
  });

  it('enforces an overall stream deadline and ignores late activity', async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      streamIdleTimeoutMs: 100,
      streamOverallTimeoutMs: 250,
    });
    await client.connect();
    const ws = getMockWs();
    const onChunk = vi.fn();

    const promise = client.callStream('agent', { message: 'endless' }, onChunk);
    const rejection = expect(promise).rejects.toThrow('Stream overall timed out');
    const req = lastSent(ws);
    await vi.advanceTimersByTimeAsync(90);
    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'one' });
    await vi.advanceTimersByTimeAsync(90);
    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'two' });
    await vi.advanceTimersByTimeAsync(70);
    await rejection;

    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'late' });
    expect(onChunk).toHaveBeenCalledTimes(2);
  });

  it('requests server cancellation when an abort signal ends supported work', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
    });
    await client.connect();
    const ws = getMockWs();
    const controller = new AbortController();
    const promise = client.call(
      'long.operation',
      {},
      {
        signal: controller.signal,
        cancel: { method: 'chat.abort', params: { runId: 'run-1' } },
      },
    );
    controller.abort();

    await expect(promise).rejects.toThrow('Request aborted');
    expect(lastSent(ws)).toMatchObject({
      method: 'chat.abort',
      params: { runId: 'run-1' },
    });
  });

  it('authenticate() resolves true once credentials match', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    const statusChanges: boolean[] = [];
    client.onStatusChange = (connected) => statusChanges.push(connected);
    // First connection attempt anonymously fails auth (password required),
    // mirroring a server configured with `auth.mode: 'password'`.
    const connectPromise = client.connect();
    const ws = getMockWs();
    ws.requiredAuth = { password: 'secret' };
    await expect(connectPromise).rejects.toThrow('Invalid or missing password');
    expect(client.isAuthenticated).toBe(false);

    // Retries the connect handshake on the same open socket with the
    // correct password.
    const result = await client.authenticate('secret');
    expect(result).toBe(true);
    expect(client.isAuthenticated).toBe(true);
    expect(client.isConnected).toBe(true);
    expect(statusChanges).toEqual([true]);

    const req = lastSent(ws);
    expect(req.method).toBe('connect');
    expect(req.params.auth.password).toBe('secret');
  });

  it('authenticateWithToken() resolves true once credentials match', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    const connectPromise = client.connect();
    const ws = getMockWs();
    ws.requiredAuth = { token: 'tok_abc' };
    await expect(connectPromise).rejects.toThrow('Invalid or missing auth token');

    const result = await client.authenticateWithToken('tok_abc');
    expect(result).toBe(true);
    expect(client.isAuthenticated).toBe(true);

    const req = lastSent(ws);
    expect(req.params.auth.token).toBe('tok_abc');
  });

  it('ignores responses delivered by a stale WebSocket generation', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const staleSocket = getMockWs();
    client.disconnect();
    await client.connect();
    const currentSocket = getMockWs();

    const promise = client.call<{ pong: number }>('ping');
    const req = lastSent(currentSocket);
    let settled = false;
    void promise.finally(() => { settled = true; });

    staleSocket.simulateMessage({ type: 'res', id: req.id, ok: true, payload: { pong: 1 } });
    await Promise.resolve();
    expect(settled).toBe(false);

    currentSocket.simulateMessage({ type: 'res', id: req.id, ok: true, payload: { pong: 2 } });
    await expect(promise).resolves.toEqual({ pong: 2 });
  });

  it('closes and rejects a superseded in-flight connection attempt', async () => {
    MockWebSocket.autoOpen = false;
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });

    const firstConnect = client.connect();
    const firstSocket = getMockWs();
    const secondConnect = client.connect();
    const secondSocket = getMockWs();

    await expect(firstConnect).rejects.toThrow('Connection superseded');
    expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED);

    MockWebSocket.autoOpen = true;
    secondSocket.simulateOpen();
    await secondConnect;
    expect(client.isConnected).toBe(true);
    expect(mockInstances).toHaveLength(2);
  });

  it('cancels a stale reconnect timer after a manual connection succeeds', async () => {
    vi.useFakeTimers();
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();

    getMockWs().close();
    await client.connect();
    expect(client.isConnected).toBe(true);
    expect(mockInstances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockInstances).toHaveLength(2);
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it('keeps reconnect retries bounded when sockets open but never finish the handshake', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoHandshake = false;
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      maxReconnectAttempts: 2,
    });

    const initialConnect = client.connect();
    await Promise.resolve();
    getMockWs().close();
    await expect(initialConnect).rejects.toThrow('Connection closed');

    await vi.advanceTimersByTimeAsync(800);
    expect(mockInstances).toHaveLength(2);
    getMockWs().close();

    await vi.advanceTimersByTimeAsync(1_360);
    expect(mockInstances).toHaveLength(3);
    getMockWs().close();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockInstances).toHaveLength(3);
    expect(client.isConnected).toBe(false);
    client.disconnect();
  });

  it('carries constructor-provided credentials through the initial handshake', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      password: 'secret',
    });
    const connectPromise = client.connect();
    const ws = getMockWs();
    ws.requiredAuth = { password: 'secret' };
    await connectPromise;
    expect(client.isAuthenticated).toBe(true);

    const req = lastSent(ws);
    expect(req.params.auth.password).toBe('secret');
  });

  it('subscribes to events', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.subscribe(['*']);
    const req = lastSent(ws);
    expect(req.method).toBe('subscribe');
    expect(req.params.events).toEqual(['*']);

    ws.simulateMessage({ type: 'res', id: req.id, ok: true, payload: { subscribed: ['*'] } });
    await promise;
  });

  it('unsubscribes from events', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234', webSocketImpl: MockWebSocket });
    await client.connect();
    const ws = getMockWs();

    const promise = client.unsubscribe(['*']);
    const req = lastSent(ws);
    expect(req.method).toBe('unsubscribe');
    expect(req.params.events).toEqual(['*']);

    ws.simulateMessage({ type: 'res', id: req.id, ok: true, payload: { unsubscribed: ['*'] } });
    await promise;
  });

  it('flushes pending requests on disconnect', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      maxReconnectAttempts: 0,
    });
    await client.connect();
    const ws = getMockWs();

    const promise = client.call('slow.method');

    // Simulate server dropping the connection
    ws.close();

    await expect(promise).rejects.toThrow('Connection closed');
  });

  it('disconnects cleanly', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      maxReconnectAttempts: 0,
    });
    await client.connect();
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it('fires onStatusChange callback', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
      webSocketImpl: MockWebSocket,
      maxReconnectAttempts: 0,
    });
    const statusChanges: boolean[] = [];
    client.onStatusChange = (connected) => statusChanges.push(connected);

    await client.connect();
    expect(statusChanges).toEqual([true]);

    client.disconnect();
    expect(statusChanges).toEqual([true, false]);
  });
});
