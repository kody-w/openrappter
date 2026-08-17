/**
 * The Bar's usage screen has to get real numbers off the real wire.
 *
 * The defect: `UsageViewModel.loadUsage()` calls `usage.stats` and
 * `loadRecentEntries()` calls `usage.history`, and the live `GatewayServer`
 * registered neither. Probed against a started server, both answered
 * `Method not found`, so the screen only ever rendered an error.
 *
 * `gateway/methods/usage-methods.ts` exists and looks like the fix, but it
 * declares *different* names (`usage.status`/`usage.cost`) against an optional
 * `usageTracker` that nothing in this repository constructs — without one it
 * returns a hardcoded `{ totalRequests: 0, totalTokens: 0, totalCost: 0 }`.
 * Registering it would have turned "Method not found" into a confident zero,
 * which is worse. These tests therefore drive the *server*, over its real
 * WebSocket and HTTP transports, with the exact frames `RpcClient.swift`
 * builds — a test that imported the method module would prove nothing about
 * production.
 *
 * The `records real activity` case is the one that matters most: a handler
 * that always answered zero would pass every other assertion here.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { GatewayServer } from '../server.js';
import { FlightRecorder, getFlightRecorder, setFlightRecorder } from '../../flight-recorder/recorder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.join(HERE, '.usage-live-tmp');

const started: GatewayServer[] = [];
const sockets: WebSocket[] = [];
const recorders: FlightRecorder[] = [];
const tempDirs: string[] = [];
let previousRecorder: FlightRecorder | null = null;

/** A real, enabled, in-memory recorder installed as the process-global one. */
async function installRecorder(): Promise<FlightRecorder> {
  const recorder = new FlightRecorder({ enabled: true, inMemory: true });
  await recorder.initialize();
  const previous = setFlightRecorder(recorder);
  if (!previousRecorder) previousRecorder = previous;
  recorders.push(recorder);
  return recorder;
}

async function boot(): Promise<GatewayServer> {
  fs.mkdirSync(SCRATCH, { recursive: true });
  // A dataDir per server: without it the gateway writes into the developer's
  // real ~/.openrappter.
  const dataDir = fs.mkdtempSync(path.join(SCRATCH, 'usage-'));
  tempDirs.push(dataDir);
  // Port 0: the OS picks a free one, so parallel test files cannot collide.
  const server = new GatewayServer({ port: 0, dataDir });
  await server.start();
  started.push(server);
  return server;
}

function portOf(server: GatewayServer): number {
  const address = (server as unknown as { httpServer: { address(): { port: number } } })
    .httpServer.address();
  return address.port;
}

interface ResponseFrame {
  type: string;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: number; message: string };
}

/**
 * A client speaking exactly what `GatewayConnection.swift` puts on the wire:
 * `{ "type": "req", "id", "method", "params" }` frames, preceded by the
 * `connect` handshake with the Bar's own client identity.
 */
async function barClient(port: number): Promise<{
  call(method: string, params?: unknown): Promise<ResponseFrame>;
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let counter = 0;
  const call = (method: string, params?: unknown): Promise<ResponseFrame> =>
    new Promise((resolve) => {
      const id = `rpc-${++counter}`;
      const onMessage = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as ResponseFrame;
        if (frame.id !== id) return;
        ws.off('message', onMessage);
        resolve(frame);
      };
      ws.on('message', onMessage);
      // RpcRequestFrame(id:method:params:) — `type` is always "req".
      ws.send(JSON.stringify(params === undefined
        ? { type: 'req', id, method }
        : { type: 'req', id, method, params }));
    });

  const hello = await call('connect', {
    client: {
      id: 'openrappter-bar',
      version: '1.13.0',
      platform: 'macos',
      mode: 'menubar',
    },
  });
  expect(hello.ok).toBe(true);
  return { call };
}

/** Record a provider attempt the way `providers/recorded-chat.ts` does. */
async function recordAttempt(
  recorder: FlightRecorder,
  options: {
    providerId?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    sessionId?: string;
    prompt?: string;
  } = {},
): Promise<void> {
  await recorder.runTrace({ sessionId: options.sessionId ?? 'bar-session' }, async () => {
    await recorder.record({
      kind: 'provider.attempt.completed',
      source: 'assistant',
      status: 'success',
      providerId: options.providerId ?? 'copilot',
      model: options.model ?? 'gpt-4o',
      durationMs: 7,
      metadata: {
        streaming: false,
        ...(options.inputTokens === undefined && options.outputTokens === undefined
          ? {}
          : {
              usage: {
                input_tokens: options.inputTokens ?? 0,
                output_tokens: options.outputTokens ?? 0,
              },
            }),
      },
      payload: () => ({ messages: [{ role: 'user', content: options.prompt ?? 'hello' }] }),
    });
  });
}

afterEach(async () => {
  while (sockets.length) sockets.pop()!.close();
  while (started.length) await started.pop()!.stop().catch(() => {});
  while (recorders.length) await recorders.pop()!.close().catch(() => {});
  if (previousRecorder) {
    setFlightRecorder(previousRecorder);
    previousRecorder = null;
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

describe('the Bar can reach usage on the live gateway', () => {
  it('registers usage.stats and usage.history on the started server', async () => {
    await installRecorder();
    const server = await boot();
    const bar = await barClient(portOf(server));

    // `methods` is what the handshake advertises; the Bar checks nothing, but
    // a name missing here is exactly how this feature died.
    const methods = (await bar.call('methods')).payload as string[];
    expect(methods).toContain('usage.stats');
    expect(methods).toContain('usage.history');
  }, 20_000);

  it('answers the exact frames RpcClient.swift sends, with no params', async () => {
    await installRecorder();
    const server = await boot();
    const bar = await barClient(portOf(server));

    const stats = await bar.call('usage.stats');
    expect(stats.ok).toBe(true);
    expect(stats.error).toBeUndefined();

    const history = await bar.call('usage.history');
    expect(history.ok).toBe(true);
    expect(Array.isArray(history.payload)).toBe(true);
  }, 20_000);

  it('returns a payload UsageStats decodes: every non-optional field present', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { inputTokens: 11, outputTokens: 7 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const payload = (await bar.call('usage.stats')).payload as Record<string, unknown>;
    // UsageModels.swift: these are non-optional `let`s. A missing key is a
    // decode failure and an error screen.
    for (const key of [
      'totalTokens',
      'promptTokens',
      'completionTokens',
      'totalCost',
      'requestCount',
    ]) {
      expect(typeof payload[key]).toBe('number');
    }
    expect(typeof payload.costAvailable).toBe('boolean');
    expect(typeof payload.period).toBe('string');
  }, 20_000);

  it('returns history entries UsageEntry decodes, timestamped ISO-8601', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { inputTokens: 3, outputTokens: 4 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const entries = (await bar.call('usage.history')).payload as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.model).toBe('string');
    expect(typeof entry.tokens).toBe('number');
    expect(typeof entry.cost).toBe('number');
    // `UsageEntry.timestamp` is a `Date`; RpcClient decodes it with an
    // ISO-8601 strategy, so anything else strands the whole list.
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp as string).toISOString()).toBe(entry.timestamp);
  }, 20_000);

  it('is reachable over HTTP JSON-RPC too (no credential configured here)', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { inputTokens: 5, outputTokens: 5 });
    const server = await boot();
    const port = portOf(server);

    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'usage.stats' }),
    });
    const body = await response.json() as { result?: { totalTokens: number }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.totalTokens).toBe(10);
  }, 20_000);

  it('refuses an unauthenticated caller when the gateway has a credential', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { inputTokens: 5, outputTokens: 5 });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const dataDir = fs.mkdtempSync(path.join(SCRATCH, 'usage-auth-'));
    tempDirs.push(dataDir);
    const server = new GatewayServer({
      port: 0,
      dataDir,
      auth: { mode: 'token', tokens: ['s3cret'] },
    });
    await server.start();
    started.push(server);
    const port = portOf(server);

    const rejected = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'usage.stats' }),
    });
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer s3cret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'usage.stats' }),
    });
    const body = await accepted.json() as { result?: { totalTokens: number } };
    expect(body.result?.totalTokens).toBe(10);
  }, 20_000);
});

describe('the numbers come from recorded activity, not from a constant', () => {  it('changes when a provider attempt is actually recorded', async () => {
    const recorder = await installRecorder();
    const server = await boot();
    const bar = await barClient(portOf(server));

    const before = (await bar.call('usage.stats')).payload as Record<string, number>;
    expect(before.totalTokens).toBe(0);
    expect(before.requestCount).toBe(0);

    await recordAttempt(recorder, { inputTokens: 120, outputTokens: 30 });

    const after = (await bar.call('usage.stats')).payload as Record<string, number>;
    expect(after.promptTokens).toBe(120);
    expect(after.completionTokens).toBe(30);
    expect(after.totalTokens).toBe(150);
    expect(after.requestCount).toBe(1);

    await recordAttempt(recorder, { inputTokens: 1, outputTokens: 2 });
    const third = (await bar.call('usage.stats')).payload as Record<string, number>;
    expect(third.totalTokens).toBe(153);
    expect(third.requestCount).toBe(2);
  }, 20_000);

  it('history grows with recorded attempts, newest first', async () => {
    const recorder = await installRecorder();
    const server = await boot();
    const bar = await barClient(portOf(server));

    expect((await bar.call('usage.history')).payload).toEqual([]);

    await recordAttempt(recorder, { model: 'gpt-4o', inputTokens: 10, outputTokens: 1 });
    await recordAttempt(recorder, { model: 'gpt-5', inputTokens: 20, outputTokens: 2 });

    const entries = (await bar.call('usage.history')).payload as Array<Record<string, unknown>>;
    expect(entries.map((e) => e.model)).toEqual(['gpt-5', 'gpt-4o']);
    expect(entries.map((e) => e.tokens)).toEqual([22, 11]);
  }, 20_000);

  it('breaks totals down by the provider and model that were recorded', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { providerId: 'copilot', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 });
    await recordAttempt(recorder, { providerId: 'ollama', model: 'llama3', inputTokens: 7, outputTokens: 3 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const stats = (await bar.call('usage.stats')).payload as {
      byProvider: Record<string, { totalTokens: number }>;
      byModel: Record<string, { totalTokens: number }>;
    };
    expect(stats.byProvider.copilot.totalTokens).toBe(15);
    expect(stats.byProvider.ollama.totalTokens).toBe(10);
    expect(stats.byModel['gpt-4o'].totalTokens).toBe(15);
    expect(stats.byModel.llama3.totalTokens).toBe(10);
  }, 20_000);

  it('counts an attempt that reported no usage without inventing tokens for it', async () => {
    const recorder = await installRecorder();
    // Streaming attempts in Assistant.ts record no `usage` at all.
    await recordAttempt(recorder, {});
    await recordAttempt(recorder, { inputTokens: 8, outputTokens: 2 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const stats = (await bar.call('usage.stats')).payload as Record<string, number>;
    expect(stats.requestCount).toBe(2);
    expect(stats.requestsWithTokenCounts).toBe(1);
    expect(stats.totalTokens).toBe(10);

    // The unmeasured attempt is not listed as a zero-token row either.
    const entries = (await bar.call('usage.history')).payload as unknown[];
    expect(entries).toHaveLength(1);
  }, 20_000);
});

describe('usage refuses to fabricate what it cannot measure', () => {
  it('reports cost as unavailable rather than as $0.00', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, { inputTokens: 1000, outputTokens: 1000 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const stats = (await bar.call('usage.stats')).payload as Record<string, unknown>;
    // There is no price table anywhere in this runtime, and the default
    // backend is a subscription with no per-token price.
    expect(stats.costAvailable).toBe(false);
    expect(stats.totalCost).toBe(0);
  }, 20_000);

  it('errors instead of answering zero when nothing is recording', async () => {
    const disabled = new FlightRecorder({ enabled: false });
    const previous = setFlightRecorder(disabled);
    if (!previousRecorder) previousRecorder = previous;
    const server = await boot();
    const bar = await barClient(portOf(server));

    for (const method of ['usage.stats', 'usage.history']) {
      const response = await bar.call(method);
      expect(response.ok).toBe(false);
      // Not the ledger's bare "Flight Recorder is disabled." — the handler
      // has to refuse *before* querying and say what to do about it, or a
      // future caching layer that swallows the ledger error turns this
      // straight back into a confident zero.
      expect(response.error?.message).toMatch(/Usage is not being recorded/);
      expect(response.error?.message).toMatch(/OPENRAPPTER_FLIGHT_RECORDER=1/);
    }
  }, 20_000);
});

describe('usage never leaks what the Flight Recorder is careful about', () => {
  it('carries no session identifier, hashed or otherwise, and no prompt text', async () => {
    const recorder = await installRecorder();
    await recordAttempt(recorder, {
      inputTokens: 9,
      outputTokens: 1,
      sessionId: 'kody-private-session',
      prompt: 'the-secret-prompt-body',
    });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const stats = JSON.stringify((await bar.call('usage.stats')).payload);
    const history = JSON.stringify((await bar.call('usage.history')).payload);

    for (const wire of [stats, history]) {
      expect(wire).not.toContain('the-secret-prompt-body');
      expect(wire).not.toContain('kody-private-session');
      expect(wire).not.toContain('sessionId');
      expect(wire).not.toContain('sessionKey');
      expect(wire).not.toContain('session:');
      expect(wire).not.toContain('payload');
      expect(wire).not.toContain('messages');
    }
  }, 20_000);

  it('does not pass anything but token counts out of event metadata', async () => {
    const recorder = await installRecorder();
    await recorder.runTrace({ sessionId: 'x' }, async () => {
      await recorder.record({
        kind: 'provider.attempt.completed',
        source: 'assistant',
        status: 'success',
        providerId: 'copilot',
        model: 'gpt-4o',
        metadata: {
          usage: { input_tokens: 2, output_tokens: 2 },
          somethingElse: 'do-not-forward-me',
        },
      });
    });
    const server = await boot();
    const bar = await barClient(portOf(server));

    const wire = JSON.stringify((await bar.call('usage.history')).payload);
    expect(wire).not.toContain('do-not-forward-me');
    expect(wire).not.toContain('somethingElse');
  }, 20_000);
});

describe('the cross-runtime usage vector still describes the live wire', () => {
  /**
   * `contracts/usage-v1.json` was captured from a live gateway over the Bar's
   * WebSocket wire, and the Swift suite decodes that same file through
   * `RpcClient`. If the gateway's shape drifts, this goes red on the TS side
   * before the Bar silently stops decoding on the Swift side.
   */
  it('reproduces contracts/usage-v1.json from the same recorded attempts', async () => {
    const vector = JSON.parse(
      fs.readFileSync(path.resolve(HERE, '../../../../contracts/usage-v1.json'), 'utf8'),
    ) as {
      'usage.stats': Record<string, unknown>;
      'usage.history': Array<Record<string, unknown>>;
    };

    const recorder = await installRecorder();
    await recordAttempt(recorder, { providerId: 'copilot', model: 'gpt-4o', inputTokens: 1200, outputTokens: 340 });
    await recordAttempt(recorder, { providerId: 'copilot', model: 'gpt-4o-mini', inputTokens: 80, outputTokens: 12 });
    const server = await boot();
    const bar = await barClient(portOf(server));

    expect((await bar.call('usage.stats')).payload).toEqual(vector['usage.stats']);

    const entries = (await bar.call('usage.history')).payload as Array<Record<string, unknown>>;
    // Event ids and wall-clock timestamps are new every run; everything the
    // Swift model reads is fixed.
    const stable = (rows: Array<Record<string, unknown>>) =>
      rows.map(({ id: _id, timestamp: _timestamp, ...rest }) => rest);
    expect(stable(entries)).toEqual(stable(vector['usage.history']));
  }, 20_000);
});

describe('the usage-methods module is deliberately not what is wired', () => {  it('does not register usage.status or usage.cost, and the built-ins are the real ones', async () => {
    await installRecorder();
    const server = await boot();
    const bar = await barClient(portOf(server));

    const methods = (await bar.call('methods')).payload as string[];
    // `registerUsageMethods` declares these two names against a tracker that
    // nothing constructs. If they ever appear here, someone wired the demo.
    expect(methods).not.toContain('usage.status');
    expect(methods).not.toContain('usage.cost');
  }, 20_000);
});

describe('the test harness itself', () => {
  it('never writes to the real ~/.openrappter data directory', async () => {
    await installRecorder();
    const server = await boot();
    const dir = (server as unknown as { config: { dataDir?: string } }).config.dataDir;
    expect(dir).toBeDefined();
    expect(dir!.startsWith(SCRATCH)).toBe(true);
  }, 20_000);

  it('restores the process-global recorder it replaced', async () => {
    await installRecorder();
    expect(getFlightRecorder()).toBe(recorders[recorders.length - 1]);
  }, 20_000);
});
