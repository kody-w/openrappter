/**
 * `RpcClient.call()` armed a 30s timeout and never cleared it on success.
 *
 * Nothing failed, so nothing looked wrong: the response arrived in
 * milliseconds, the promise resolved, and the CLI printed the right answer
 * immediately. But an un-cleared `setTimeout` is an active libuv handle, and
 * Node will not exit while one is pending -- so every RPC-backed command sat
 * in the terminal for the full 30 seconds after doing its work:
 *
 *     $ time openrappter backup list
 *     No backups yet. Create one with:
 *         openrappter backup create
 *     real  0m30.143s        <- output was instant; the process was not
 *
 * After clearing the timer in both settle paths, the same command is 0.107s.
 *
 * ## Why this file does not count process-wide timers
 *
 * The first version of these tests asserted on `process.getActiveResourcesInfo()`
 * -- a process-wide count of pending handles. That reads like a strong
 * end-to-end check and is in fact flaky: vitest runs test files concurrently
 * in one process, so timers armed by an unrelated file land in the same count
 * and the delta stops being attributable to this client. It passed locally and
 * failed in CI, which is the worst way to find out.
 *
 * These tests instead identify the RPC timer precisely -- by the handle
 * `setTimeout` returned, discriminated by its 30s delay -- and assert that
 * exact handle reached `clearTimeout`. Deterministic regardless of what else
 * the process is doing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import { RpcClient } from '../../cli/rpc-client.js';

/** The delay `RpcClient.call` arms; distinguishes its timer from ws internals. */
const RPC_TIMEOUT_MS = 30_000;

let server: WebSocketServer | undefined;
let client: RpcClient | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  client?.disconnect();
  client = undefined;
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

/** A gateway that answers `echo`, errors on `boom`, and ignores `blackhole`. */
async function startServer(): Promise<number> {
  server = new WebSocketServer({ port: 0 });
  server.on('connection', (socket: WS) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; id: string; method: string };
      if (frame.type !== 'req') return;
      if (frame.method === 'blackhole') return; // deliberately silent
      if (frame.method === 'boom') {
        socket.send(
          JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'nope' } }),
        );
        return;
      }
      socket.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => server!.on('listening', () => resolve()));
  return (server!.address() as { port: number }).port;
}

/** Watch the timer functions, reporting only timers armed at the RPC delay. */
function watchTimers() {
  const armed: unknown[] = [];
  const cleared: unknown[] = [];

  const realSet = global.setTimeout;
  vi.spyOn(global, 'setTimeout').mockImplementation(((
    fn: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const handle = realSet(fn, ms as number, ...rest);
    if (ms === RPC_TIMEOUT_MS) armed.push(handle);
    return handle;
  }) as unknown as typeof global.setTimeout);

  const realClear = global.clearTimeout;
  vi.spyOn(global, 'clearTimeout').mockImplementation(((handle: unknown) => {
    cleared.push(handle);
    return realClear(handle as Parameters<typeof global.clearTimeout>[0]);
  }) as unknown as typeof global.clearTimeout);

  return {
    armed,
    allCleared: () => armed.length > 0 && armed.every((h) => cleared.includes(h)),
    clearedCount: () => armed.filter((h) => cleared.includes(h)).length,
  };
}

describe('RpcClient timer lifecycle', () => {
  it('arms a timeout for each call and keeps it while unanswered', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const timers = watchTimers();
    const pending = client.call('blackhole');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Guard the guard: if no timer is ever armed, every "was it cleared?"
    // assertion below would pass vacuously against a client with no timeout
    // at all -- and the 30s safety net would silently not exist.
    expect(timers.armed.length).toBe(1);

    // An unanswered call must KEEP its timer: that is the guard working.
    expect(timers.clearedCount()).toBe(0);

    void pending.catch(() => undefined);
  });

  it('clears the timer when a call resolves', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const timers = watchTimers();
    await client.call('echo');
    await client.call('echo');
    await client.call('echo');

    // Three round-trips, three timers, all cleared. Before the fix none were,
    // and each one kept the CLI alive for 30 seconds.
    expect(timers.armed.length).toBe(3);
    expect(timers.allCleared()).toBe(true);
  });

  it('clears the timer when a call rejects', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const timers = watchTimers();
    await expect(client.call('boom')).rejects.toThrow('nope');

    // The error path matters just as much: `approvals list` against an older
    // gateway rejects with "method not found", and used to leave the CLI
    // hanging on top of printing a stack trace.
    expect(timers.armed.length).toBe(1);
    expect(timers.allCleared()).toBe(true);
  });
});
