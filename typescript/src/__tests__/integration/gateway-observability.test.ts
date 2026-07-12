/**
 * Gateway Observability Tests (cycle-11: OPERABILITY)
 *
 * Behavioral coverage for the bounded in-memory counters and structured
 * logging added in `typescript/src/gateway/observability.ts` and wired
 * into `GatewayServer`:
 *  - RPC outcome counters (success/error/auth_failure/rate_limited/timeout)
 *    increment exactly once per HTTP and WS dispatch attempt
 *  - `/health`, `/status`, and the canonical `health`/`status` RPCs never
 *    count health polling as an RPC request
 *  - Active connection and active agent execution gauges
 *  - Predictable reset semantics: a fresh server instance starts at zero
 *  - Structured JSON logging opt-in via OPENRAPPTER_LOG_FORMAT=json, with
 *    credential redaction and no per-request noise by default
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { GatewayServer as RuntimeGatewayServer } from '../../gateway/server.js';
import type { GatewayConfig } from '../../gateway/types.js';
import {
  GatewayMetrics,
  logGatewayLifecycle,
  logGatewayRequest,
} from '../../gateway/observability.js';
import WebSocket from 'ws';

let testDataDir = '';

class GatewayServer extends RuntimeGatewayServer {
  constructor(config: Partial<GatewayConfig>) {
    super({ ...config, dataDir: testDataDir });
  }
}

function randomPort(): number {
  return 34000 + Math.floor(Math.random() * 10000);
}

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

async function doConnect(ws: WebSocket): Promise<Record<string, unknown>> {
  return rpc(ws, 'connect', { client: { id: 'obs-test', version: '1.0.0', platform: 'node', mode: 'test' } });
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, init);
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Gateway Observability', () => {
  let server: GatewayServer | null = null;

  beforeEach(() => {
    testDataDir = fs.mkdtempSync(path.join(process.cwd(), '.gateway-observability-'));
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    delete process.env.OPENRAPPTER_LOG_FORMAT;
    fs.rmSync(testDataDir, { recursive: true, force: true });
  });

  // ── Metrics unit behavior ─────────────────────────────────────────────

  describe('GatewayMetrics (unit)', () => {
    it('starts every counter at zero for a fresh instance', () => {
      const metrics = new GatewayMetrics();
      const snapshot = metrics.snapshot(0);
      expect(snapshot).toEqual({
        rpcRequestsTotal: 0,
        rpcSuccessTotal: 0,
        rpcErrorsTotal: 0,
        rpcAuthFailuresTotal: 0,
        rpcRateLimitedTotal: 0,
        rpcTimeoutsTotal: 0,
        activeConnections: 0,
        activeAgentExecutions: 0,
        uptimeSeconds: 0,
      });
    });

    it('increments exactly one outcome counter (plus total) per recordRequest call', () => {
      const metrics = new GatewayMetrics();
      metrics.recordRequest('success');
      metrics.recordRequest('error');
      metrics.recordRequest('auth_failure');
      metrics.recordRequest('rate_limited');
      metrics.recordRequest('timeout');

      const snapshot = metrics.snapshot(0);
      expect(snapshot.rpcRequestsTotal).toBe(5);
      expect(snapshot.rpcSuccessTotal).toBe(1);
      expect(snapshot.rpcErrorsTotal).toBe(1);
      expect(snapshot.rpcAuthFailuresTotal).toBe(1);
      expect(snapshot.rpcRateLimitedTotal).toBe(1);
      expect(snapshot.rpcTimeoutsTotal).toBe(1);
    });

    it('tracks the active agent execution gauge without going negative', () => {
      const metrics = new GatewayMetrics();
      metrics.agentExecutionStarted();
      metrics.agentExecutionStarted();
      expect(metrics.snapshot(0).activeAgentExecutions).toBe(2);
      metrics.agentExecutionFinished();
      expect(metrics.snapshot(0).activeAgentExecutions).toBe(1);
      metrics.agentExecutionFinished();
      metrics.agentExecutionFinished(); // extra finish must not go negative
      expect(metrics.snapshot(0).activeAgentExecutions).toBe(0);
    });

    it('reports uptime as 0 until start() is called, and 0 again after stop()', () => {
      const metrics = new GatewayMetrics();
      expect(metrics.snapshot(0).uptimeSeconds).toBe(0);
      metrics.start();
      expect(metrics.snapshot(0).uptimeSeconds).toBeGreaterThanOrEqual(0);
      metrics.stop();
      expect(metrics.snapshot(0).uptimeSeconds).toBe(0);
    });

    it('reset() clears every counter and gauge back to zero', () => {
      const metrics = new GatewayMetrics();
      metrics.recordRequest('success');
      metrics.recordRequest('error');
      metrics.agentExecutionStarted();
      metrics.start();
      metrics.reset();
      const snapshot = metrics.snapshot(0);
      expect(snapshot.rpcRequestsTotal).toBe(0);
      expect(snapshot.rpcSuccessTotal).toBe(0);
      expect(snapshot.rpcErrorsTotal).toBe(0);
      expect(snapshot.activeAgentExecutions).toBe(0);
      expect(snapshot.uptimeSeconds).toBe(0);
    });
  });

  // ── Wired into GatewayServer ──────────────────────────────────────────

  describe('GatewayServer wiring', () => {
    it('a brand-new server instance reports zeroed metrics via /status and /health', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const status = await fetchJson(`http://127.0.0.1:${port}/status`);
      const health = await fetchJson(`http://127.0.0.1:${port}/health`);

      expect(status.metrics).toMatchObject({ rpcRequestsTotal: 0, rpcSuccessTotal: 0, activeConnections: 0 });
      expect(health.metrics).toMatchObject({ rpcRequestsTotal: 0, rpcSuccessTotal: 0, activeConnections: 0 });
    });

    it('never counts /health or /status polling as an RPC request', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      for (let i = 0; i < 5; i++) {
        await fetchJson(`http://127.0.0.1:${port}/health`);
        await fetchJson(`http://127.0.0.1:${port}/status`);
      }

      const status = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((status.metrics as Record<string, number>).rpcRequestsTotal).toBe(0);
    });

    it('increments the success counter exactly once per successful WS RPC dispatch', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      await rpc(ws, 'ping');
      await rpc(ws, 'ping');
      // The status RPC's own snapshot reflects counts as of when its handler
      // runs — before its own outcome is recorded — so it captures the two
      // prior pings only, not itself.
      const statusRes = await rpc(ws, 'status');
      const metrics = (statusRes.payload as { metrics: Record<string, number> }).metrics;

      expect(metrics.rpcRequestsTotal).toBe(2);
      expect(metrics.rpcSuccessTotal).toBe(2);
      expect(metrics.rpcErrorsTotal).toBe(0);
      ws.close();
    });

    it('increments the error counter exactly once for an unknown method over WS', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const res = await rpc(ws, 'totally.unknown.method');
      expect(res.ok).toBe(false);

      const statusRes = await rpc(ws, 'status');
      const metrics = (statusRes.payload as { metrics: Record<string, number> }).metrics;
      expect(metrics.rpcErrorsTotal).toBe(1);
      ws.close();
    });

    it('increments the auth_failure counter exactly once for a requiresAuth method called unauthenticated', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'token', tokens: ['secret-token'] } });
      server.registerMethod('protected.thing', async () => ({ ok: true }), { requiresAuth: true });
      await server.start();

      // HTTP path: no credential supplied against a token-mode server
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'protected.thing' }),
      });
      expect(res.status).toBe(401);

      const status = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((status.metrics as Record<string, number>).rpcAuthFailuresTotal).toBe(1);
      expect((status.metrics as Record<string, number>).rpcRequestsTotal).toBe(1);
    });

    it('increments the rate_limited counter exactly once when the WS rate limit window is exceeded', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);

      const results: Record<string, unknown>[] = [];
      // RATE_LIMIT_MAX_REQUESTS is 100/min; fire well past that in one window.
      for (let i = 0; i < 105; i++) {
        results.push(await rpc(ws, 'ping'));
      }

      const rateLimited = results.filter((r) => r.ok === false && (r.error as { code: number }).code === -32001);
      expect(rateLimited.length).toBeGreaterThan(0);

      // Check via HTTP /status — the WS connection itself is still rate
      // limited in this window, so an extra WS RPC would be unreliable.
      const status = await fetchJson(`http://127.0.0.1:${port}/status`);
      const metrics = (status.metrics as Record<string, number>);
      expect(metrics.rpcRateLimitedTotal).toBe(rateLimited.length);
      ws.close();
    }, 15000);

    it('increments the timeout counter exactly once when a handler exceeds an opt-in executionTimeoutMs', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' }, executionTimeoutMs: 50 });
      server.registerMethod('slow.thing', () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 2000)));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const res = await rpc(ws, 'slow.thing');
      expect(res.ok).toBe(false);
      expect((res.error as { code: number }).code).toBe(-32002);

      const statusRes = await rpc(ws, 'status');
      const metrics = (statusRes.payload as { metrics: Record<string, number> }).metrics;
      expect(metrics.rpcTimeoutsTotal).toBe(1);
      ws.close();
    }, 10000);

    it('does not enforce a timeout when executionTimeoutMs is unset (default, non-breaking)', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.registerMethod('slow.thing', () => new Promise((resolve) => setTimeout(() => resolve({ done: true }), 150)));
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const res = await rpc(ws, 'slow.thing');
      expect(res.ok).toBe(true);
      expect((res.payload as { done: boolean }).done).toBe(true);
      ws.close();
    });

    it('tracks the active connections gauge as WS clients connect and disconnect', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws1 = await connectWs(port);
      await doConnect(ws1);
      const ws2 = await connectWs(port);
      await doConnect(ws2);

      let status = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((status.metrics as Record<string, number>).activeConnections).toBe(2);

      ws1.close();
      await new Promise((r) => setTimeout(r, 200));

      status = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((status.metrics as Record<string, number>).activeConnections).toBe(1);

      ws2.close();
    });

    it('tracks the active agent executions gauge while an agent run is in flight, and clears it after', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      let releaseAgent: (() => void) | undefined;
      server.setAgentHandler(async (req) => {
        await new Promise<void>((resolve) => { releaseAgent = resolve; });
        return { content: 'done', sessionId: req.sessionId ?? 'x', finishReason: 'stop' };
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const agentPromise = rpc(ws, 'agent', { message: 'hi' });

      // Give the handler a moment to start and register as in-flight.
      await new Promise((r) => setTimeout(r, 50));
      const midFlight = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((midFlight.metrics as Record<string, number>).activeAgentExecutions).toBe(1);

      expect(releaseAgent).toBeDefined();
      releaseAgent!();
      await agentPromise;

      const afterFlight = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((afterFlight.metrics as Record<string, number>).activeAgentExecutions).toBe(0);
      ws.close();
    });

    it('tracks cronService runs with the same execution gauge', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      let releaseRun: (() => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      server.setCronService({
        list: () => [],
        run: async () => {
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
            markStarted?.();
          });
        },
        enable: async () => undefined,
        disable: async () => undefined,
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const runPromise = rpc(ws, 'cron.run', { jobId: 'job-1' });
      await started;

      const midFlight = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((midFlight.metrics as Record<string, number>).activeAgentExecutions).toBe(1);

      releaseRun!();
      const runResult = await runPromise;
      expect(runResult.ok).toBe(true);
      const afterFlight = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((afterFlight.metrics as Record<string, number>).activeAgentExecutions).toBe(0);
      ws.close();
    });

    it('clears the cron execution gauge when the trigger branch fails', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      server.setCronService({
        list: () => [],
        run: async () => { throw new Error('cron failed'); },
        enable: async () => undefined,
        disable: async () => undefined,
      });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      const result = await rpc(ws, 'cron.trigger', { jobId: 'job-1' });
      expect(result.ok).toBe(false);

      const status = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((status.metrics as Record<string, number>).activeAgentExecutions).toBe(0);
      ws.close();
    });

    it('a fresh server instance always starts with zeroed counters (predictable reset per instance/start)', async () => {
      const port1 = randomPort();
      const server1 = new GatewayServer({ port: port1, bind: 'loopback', auth: { mode: 'none' } });
      await server1.start();
      const ws1 = await connectWs(port1);
      await doConnect(ws1);
      await rpc(ws1, 'ping');
      const status1 = await fetchJson(`http://127.0.0.1:${port1}/status`);
      expect((status1.metrics as Record<string, number>).rpcRequestsTotal).toBeGreaterThan(0);
      ws1.close();
      await server1.stop();

      const port2 = randomPort();
      server = new GatewayServer({ port: port2, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();
      const status2 = await fetchJson(`http://127.0.0.1:${port2}/status`);
      expect((status2.metrics as Record<string, number>).rpcRequestsTotal).toBe(0);
    });

    it('restarting the same server instance (stop then start) resets counters back to zero', async () => {
      const port = randomPort();
      server = new GatewayServer({ port, bind: 'loopback', auth: { mode: 'none' } });
      await server.start();

      const ws = await connectWs(port);
      await doConnect(ws);
      await rpc(ws, 'ping');
      const before = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((before.metrics as Record<string, number>).rpcRequestsTotal).toBeGreaterThan(0);
      ws.close();

      await server.stop();
      await new Promise((r) => setTimeout(r, 50));
      await server.start();
      await new Promise((r) => setTimeout(r, 50));

      const after = await fetchJson(`http://127.0.0.1:${port}/status`);
      expect((after.metrics as Record<string, number>).rpcRequestsTotal).toBe(0);
      expect((after.metrics as Record<string, number>).activeConnections).toBe(0);
    });
  });

  // ── Structured logging ────────────────────────────────────────────────

  describe('structured JSON logging', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      logSpy.mockRestore();
    });

    it('emits human-readable text by default (no OPENRAPPTER_LOG_FORMAT set)', () => {
      delete process.env.OPENRAPPTER_LOG_FORMAT;
      logGatewayLifecycle('gateway', 'start', 'Gateway server started on 127.0.0.1:18790', { port: 18790 });
      expect(logSpy).toHaveBeenCalledWith('Gateway server started on 127.0.0.1:18790');
    });

    it('emits a parseable JSON line with timestamp/level/component/event when OPENRAPPTER_LOG_FORMAT=json', () => {
      process.env.OPENRAPPTER_LOG_FORMAT = 'json';
      logGatewayLifecycle('gateway', 'start', 'Gateway server started', { port: 18790 });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('gateway');
      expect(parsed.event).toBe('start');
      expect(typeof parsed.timestamp).toBe('string');
      expect(new Date(parsed.timestamp).toString()).not.toBe('Invalid Date');
      expect(parsed.port).toBe(18790);
    });

    it('redacts fields whose keys look like secrets, even if a caller mistakenly includes one', () => {
      process.env.OPENRAPPTER_LOG_FORMAT = 'json';
      logGatewayLifecycle('gateway', 'start', 'msg', { token: 'super-secret-value', authorization: 'Bearer abc', safeCount: 3 });

      const line = logSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(line);
      expect(parsed.token).toBe('[REDACTED]');
      expect(parsed.authorization).toBe('[REDACTED]');
      expect(parsed.safeCount).toBe(3);
      expect(line).not.toContain('super-secret-value');
      expect(line).not.toContain('Bearer abc');
    });

    it('suppresses per-request logs by default (no console noise unless JSON mode is explicitly enabled)', () => {
      delete process.env.OPENRAPPTER_LOG_FORMAT;
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'success', durationMs: 3 });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('emits per-request logs only when JSON mode is explicitly enabled, without method names or unbounded labels', () => {
      process.env.OPENRAPPTER_LOG_FORMAT = 'json';
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'success', durationMs: 3 });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(parsed.transport).toBe('ws');
      expect(parsed.outcome).toBe('success');
      expect(parsed.durationMs).toBe(3);
      expect(parsed.method).toBeUndefined();
    });
  });
});
