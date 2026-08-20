/**
 * `cron.runs` is the dashboard's name for `cron.logs`.
 *
 * Reproduced first, over HTTP against a started gateway:
 *
 *   cron.runs {"jobId":"job1"} -> {"code":-32601,"message":"Method not found: cron.runs"}
 *   cron.logs {"jobId":"job1"} -> {"result":{"runs":[]}}
 *
 * So the run-history panel in `ui/src/components/cron.ts` was empty for a
 * feature the gateway already had, under a second name. The fix aliases the
 * canonical handler rather than writing a second implementation — the mistake
 * `cron.delete` made in #166, where an alias with its own body kept the old bug
 * after the original was fixed. `methods/cron-methods.ts` does declare
 * `cron.runs`, but over its own in-memory `cronStore` and with a `{ limit }`
 * parameter the UI does not send; it is never registered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayServer } from '../server.js';

let server: GatewayServer | undefined;
const temps: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = undefined;
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A scheduler that has actually run something. */
function schedulerWithHistory() {
  const logs = [
    { jobId: 'job1', timestamp: 1, success: true, durationMs: 12 },
    { jobId: 'job2', timestamp: 2, success: false, durationMs: 5, error: 'boom' },
    { jobId: 'job1', timestamp: 3, success: false, durationMs: 7, error: 'again' },
  ];
  return {
    list: () => [{ id: 'job1', name: 'one', schedule: '* * * * *', enabled: true }],
    run: async () => {},
    enable: async () => {},
    disable: async () => {},
    getRunLogs: (jobId?: string) => (jobId ? logs.filter((l) => l.jobId === jobId) : [...logs]),
  };
}

async function boot(): Promise<number> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cron-runs-alias-'));
  temps.push(dataDir);
  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const port = server.port;
  server.setCronService(schedulerWithHistory() as never);
  return port;
}

async function rpc(port: number, method: string, params?: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', method, params }),
  });
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

describe('cron.runs', () => {
  it('exists on the running gateway', async () => {
    const port = await boot();
    const { error } = await rpc(port, 'cron.runs', { jobId: 'job1' });
    expect(error?.code).not.toBe(-32601);
  });

  it('returns { runs } for the requested job, the shape the UI destructures', async () => {
    const port = await boot();
    // ui/src/components/cron.ts: `const res = await gateway.call(...); this.runs = res.runs ?? []`
    const { result } = await rpc(port, 'cron.runs', { jobId: 'job1' });
    const runs = result?.runs as Array<{ jobId: string }>;
    expect(Array.isArray(runs)).toBe(true);
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.jobId === 'job1')).toBe(true);
  });

  it('agrees with cron.logs call for call', async () => {
    const port = await boot();
    for (const params of [{ jobId: 'job1' }, { jobId: 'job2' }, {}]) {
      const runs = await rpc(port, 'cron.runs', params);
      const logs = await rpc(port, 'cron.logs', params);
      expect(runs.result).toEqual(logs.result);
    }
  });

  it('is the same handler object as cron.logs, not a copy of it', async () => {
    // #166's lesson: an alias that re-derives the lookup drifts from the
    // implementation it is supposed to be an alias for.
    await boot();
    const methods = (server as unknown as {
      methods: Map<string, { handler: unknown }>;
    }).methods;
    expect(methods.get('cron.runs')!.handler).toBe(methods.get('cron.logs')!.handler);
  });

  it('answers { runs: [] } when no scheduler is wired, rather than throwing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cron-runs-bare-'));
    temps.push(dataDir);
    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
    await server.start();
    const port = server.port;

    const { result, error } = await rpc(port, 'cron.runs', { jobId: 'job1' });
    expect(error).toBeUndefined();
    expect(result?.runs).toEqual([]);
  });
});
