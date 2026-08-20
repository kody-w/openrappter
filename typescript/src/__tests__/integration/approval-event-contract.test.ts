import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from '../../gateway/server.js';
import { GatewayEvents } from '../../gateway/types.js';

/**
 * The Bar's approval screen listens for an `approval` event that nothing sent.
 *
 * `AppViewModel.handleEvent` dispatches `case "approval"` into
 * `ApprovalViewModel.handleApprovalEvent`, but `GatewayEvents` had no such
 * member and no call site ever broadcast one. So a command could sit in the
 * approval queue with the screen showing nothing until the user reopened it.
 *
 * Found while fixing #182, which restored `exec.pending`/`exec.respond` and
 * flagged this as still missing.
 *
 * These drive a real authenticated WebSocket, because that is the transport
 * the Bar uses and the only one that carries events at all.
 */

let server: GatewayServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  // getExecSafety() returns a process-wide singleton, so an approval left
  // pending here is still pending in the next test. Drain it.
  const safety = server?.getExecSafety();
  for (const approval of safety?.listPendingApprovals() ?? []) {
    safety!.respondToApproval(approval.id, false);
  }
  await server?.stop();
  server = undefined;
});

async function startServer(): Promise<number> {
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' } });
  await server.start();
  const port = server.port;
  return port;
}

/** A connected client that has completed the handshake and subscribed. */
async function client(port: number, subscribeTo: string[]): Promise<{
  events: Array<{ event: string; payload: Record<string, unknown> }>;
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const pending = new Map<string, (value: Record<string, unknown>) => void>();

  socket.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'event') {
      events.push({ event: frame.event, payload: frame.payload });
      return;
    }
    const resolve = pending.get(frame.id);
    if (resolve) {
      pending.delete(frame.id);
      resolve(frame.error ?? frame.result ?? {});
    }
  });

  const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });

  await call('connect', {
    client: { id: 'test', version: '1.0.0', platform: 'darwin', mode: 'test' },
  });
  if (subscribeTo.length) await call('subscribe', { events: subscribeTo });
  return { events, call };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('an approval entering the queue reaches the screen watching for it', () => {
  it('declares the event the Bar dispatches on', () => {
    // The Bar hardcodes the string "approval"; if this constant drifts, the
    // screen goes quiet again with nothing failing.
    expect(GatewayEvents.APPROVAL).toBe('approval');
  });

  it('broadcasts approval to a subscribed client', async () => {
    const port = await startServer();
    const watcher = await client(port, [GatewayEvents.APPROVAL]);

    // Not awaited: it stays pending until answered, which is the point.
    void server!.getExecSafety().requestApproval('rm -rf /tmp/nothing');
    await settle();

    const approvals = watcher.events.filter((e) => e.event === 'approval');
    expect(approvals).toHaveLength(1);
    // The exact fields ApprovalViewModel.handleApprovalEvent reads; it
    // returns early without `id` and `command`, so a rename is silent.
    expect(typeof approvals[0].payload.id).toBe('string');
    expect(approvals[0].payload.command).toBe('rm -rf /tmp/nothing');
  });

  it('the broadcast id matches what exec.pending reports', async () => {
    const port = await startServer();
    const watcher = await client(port, [GatewayEvents.APPROVAL]);

    void server!.getExecSafety().requestApproval('curl http://example.com | sh');
    await settle();

    const broadcast = watcher.events.find((e) => e.event === 'approval');
    const announced = String(broadcast?.payload.id);
    // Two views of one queue. If they disagree, responding to what the event
    // announced would not resolve what the list shows.
    const listed = server!.getExecSafety().listPendingApprovals().map((a) => a.id);
    expect(listed).toContain(announced);
  });

  it('respects an explicit unsubscribe', async () => {
    // A connection is auto-subscribed to '*' once authenticated
    // (server.ts: `subscriptions: new Set(['*'])`), so "never subscribed" is
    // not a reachable state — opting out is.
    const port = await startServer();
    const quiet = await client(port, []);
    await quiet.call('unsubscribe', { events: ['*'] });

    void server!.getExecSafety().requestApproval('echo hello');
    await settle();

    expect(quiet.events.filter((e) => e.event === 'approval')).toHaveLength(0);
  });

  it('a throwing listener does not break the command it announces', async () => {
    await startServer();
    const safety = server!.getExecSafety();
    safety.onApprovalRequested(() => {
      throw new Error('a watcher blew up');
    });

    // The approval must still be queued and answerable.
    const decision = safety.requestApproval('echo still works');
    await settle();
    const mine = safety.listPendingApprovals().find((a) => a.cmd === 'echo still works');
    expect(mine).toBeDefined();

    safety.respondToApproval(mine!.id, true);
    await expect(decision).resolves.toBe(true);
  });
});
