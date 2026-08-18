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
 * These tests assert on the handle itself rather than on wall-clock time, so
 * they cannot flake on a slow machine and cannot pass merely because the test
 * runner happened to be quick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import { RpcClient } from '../../cli/rpc-client.js';

/** Count pending timers held open by the process. */
function timerCount(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

let server: WebSocketServer | undefined;
let client: RpcClient | undefined;

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = undefined;
});

/** A gateway that answers `echo` and never answers `blackhole`. */
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

describe('RpcClient timer lifecycle', () => {
  it('holds a timer open only while a call is in flight', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const before = timerCount();

    // A call that never gets a response must keep its timeout armed --
    // otherwise the 30s guard would not exist at all, and this test would
    // pass vacuously against a client that simply never sets a timer.
    const pending = client.call('blackhole');
    expect(timerCount()).toBeGreaterThan(before);

    // A resolved call must leave nothing behind.
    await client.call('echo');
    expect(timerCount()).toBe(before + 1); // still just the blackhole's

    void pending.catch(() => undefined);
  });

  it('clears the timer when a call resolves', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const before = timerCount();
    await client.call('echo');
    await client.call('echo');
    await client.call('echo');

    // Three round-trips, zero residue. Before the fix this was `before + 3`,
    // and each one kept the CLI alive for 30 seconds.
    expect(timerCount()).toBe(before);
  });

  it('clears the timer when a call rejects', async () => {
    const port = await startServer();
    client = new RpcClient();
    await client.connect(port);

    const before = timerCount();
    await expect(client.call('boom')).rejects.toThrow('nope');

    // The error path matters just as much: `approvals list` against an older
    // gateway rejects with "method not found", and used to leave the CLI
    // hanging on top of printing a stack trace.
    expect(timerCount()).toBe(before);
  });
});
