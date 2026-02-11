/**
 * Tests for the GatewayClient service.
 * Uses a mock WebSocket to test connect, call, events, streaming, and reconnect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient } from '../services/gateway.js';

// --- Mock WebSocket ---

let mockInstances: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;

  sent: string[] = [];

  constructor(_url: string) {
    mockInstances.push(this);
    // Auto-open on next microtask so handlers are set first
    Promise.resolve().then(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  mockInstances = [];
  (globalThis as any).WebSocket = MockWebSocket;
  // Copy static constants needed by GatewayClient
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
  (globalThis as any).WebSocket.CLOSED = MockWebSocket.CLOSED;
  (globalThis as any).WebSocket.CONNECTING = MockWebSocket.CONNECTING;
});

afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

function getMockWs(): MockWebSocket {
  return mockInstances[mockInstances.length - 1];
}

describe('GatewayClient', () => {
  it('connects and resolves', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    expect(client.isConnected).toBe(true);
  });

  it('sends RPC requests and receives responses', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const promise = client.call<{ pong: number }>('ping');

    expect(ws.sent).toHaveLength(1);
    const req = JSON.parse(ws.sent[0]);
    expect(req.method).toBe('ping');

    ws.simulateMessage({ id: req.id, result: { pong: 123 } });

    const result = await promise;
    expect(result.pong).toBe(123);
  });

  it('rejects RPC on error response', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const promise = client.call('bad.method');
    const req = JSON.parse(ws.sent[0]);
    ws.simulateMessage({
      id: req.id,
      error: { code: -32601, message: 'Method not found' },
    });

    await expect(promise).rejects.toThrow('Method not found');
  });

  it('rejects call when not connected', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await expect(client.call('test')).rejects.toThrow('Not connected');
  });

  it('dispatches events to listeners', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('heartbeat', handler);

    ws.simulateMessage({ event: 'heartbeat', data: { uptime: 100 } });

    expect(handler).toHaveBeenCalledWith({ uptime: 100 });
  });

  it('dispatches wildcard events', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('*', handler);

    ws.simulateMessage({ event: 'chat.message', data: { text: 'hi' } });

    expect(handler).toHaveBeenCalledWith({
      event: 'chat.message',
      data: { text: 'hi' },
    });
  });

  it('removes event listeners with off()', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const handler = vi.fn();
    client.on('heartbeat', handler);
    client.off('heartbeat', handler);

    ws.simulateMessage({ event: 'heartbeat', data: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handles streaming responses', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
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

    const req = JSON.parse(ws.sent[0]);
    expect(req.params.stream).toBe(true);

    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'Hello ' });
    ws.simulateMessage({ id: req.id, streaming: true, chunk: 'world!' });
    ws.simulateMessage({ id: req.id, streaming: true, done: true });

    await promise;
    expect(chunks).toEqual(['Hello ', 'world!']);
  });

  it('authenticates with password', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const promise = client.authenticate('secret');
    const req = JSON.parse(ws.sent[0]);
    expect(req.method).toBe('auth');
    expect(req.params.password).toBe('secret');

    ws.simulateMessage({ id: req.id, result: { authenticated: true } });

    const result = await promise;
    expect(result).toBe(true);
    expect(client.isAuthenticated).toBe(true);
  });

  it('authenticates with token', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const promise = client.authenticateWithToken('tok_abc');
    const req = JSON.parse(ws.sent[0]);
    expect(req.params.token).toBe('tok_abc');

    ws.simulateMessage({ id: req.id, result: { authenticated: true } });
    expect(await promise).toBe(true);
  });

  it('subscribes to events', async () => {
    const client = new GatewayClient({ url: 'ws://test:1234' });
    await client.connect();
    const ws = getMockWs();

    const promise = client.subscribe(['*']);
    const req = JSON.parse(ws.sent[0]);
    expect(req.method).toBe('subscribe');
    expect(req.params.events).toEqual(['*']);

    ws.simulateMessage({ id: req.id, result: { subscribed: ['*'] } });
    await promise;
  });

  it('flushes pending requests on disconnect', async () => {
    const client = new GatewayClient({
      url: 'ws://test:1234',
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
