import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayServer } from '../../gateway/server.js';
import { CronService } from '../../cron/service.js';
import { createCronGatewayAdapter } from '../../cron/gateway-adapter.js';

/**
 * `cron.get` read only the gateway's file fallback, never the live scheduler.
 * So the gateway would create a job, answer `{ scheduled: true }`, and then
 * deny that the job existed:
 *
 *   cron.create -> {"id":"job_...","scheduled":true}
 *   live jobs   -> job_...
 *   cron.get    -> Job not found: job_...
 *
 * `cron.update` was not registered at all, though the macOS Bar calls it and
 * `CronService.updateJob` has always existed.
 *
 * Both are the split that made `cron.delete` lie in #166: two stores, and a
 * handler wired to the one that is not authoritative.
 *
 * These go over real HTTP to a real GatewayServer with a real CronService,
 * wired by the daemon's own adapter. `gateway/methods/cron-methods.ts` is
 * deliberately never registered, so a test importing it would prove nothing.
 */

let server: GatewayServer | undefined;
let cron: CronService | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  cron?.stop();
  cron = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

async function startServer(): Promise<number> {
  dataDir = mkdtempSync(join(tmpdir(), 'cron-get-'));

  const service = new CronService();
  await service.start({ execute: async () => 'ok' });
  cron = service;

  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const port = server.port;
  server.setCronService(createCronGatewayAdapter({ service, persist: () => {} }));
  return port;
}

async function rpc(port: number, method: string, params?: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c1', method, params }),
  });
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
}

async function createJob(port: number): Promise<string> {
  const { result } = await rpc(port, 'cron.create', {
    name: 'contract', schedule: '* * * * *', agentId: 'Assistant', message: 'hello',
  });
  expect(result?.scheduled).toBe(true);
  return String(result?.id);
}

describe('cron.get and cron.update reach the scheduler that actually holds the job', () => {
  it('finds a job the gateway itself just created', async () => {
    const port = await startServer();
    const id = await createJob(port);

    const { result, error } = await rpc(port, 'cron.get', { jobId: id });

    expect(error).toBeUndefined();
    expect(result?.id).toBe(id);
    expect(result?.message).toBe('hello');
  });

  it('still refuses an id that exists nowhere', async () => {
    const port = await startServer();

    const { error } = await rpc(port, 'cron.get', { jobId: 'no-such-job' });

    expect(error?.message).toMatch(/not found/i);
  });

  it('cron.update is registered, because the Bar calls it', async () => {
    const port = await startServer();
    const id = await createJob(port);

    const { result, error } = await rpc(port, 'cron.update', { jobId: id, enabled: false });

    expect(error).toBeUndefined();
    expect(result?.enabled).toBe(false);
  });

  it('an update is visible to the next read, not just in its own reply', async () => {
    const port = await startServer();
    const id = await createJob(port);

    await rpc(port, 'cron.update', { jobId: id, message: 'changed' });
    const { result } = await rpc(port, 'cron.get', { jobId: id });

    expect(result?.message).toBe('changed');
  });

  it('accepts the Bar spelling `command` and stores it as `message`', async () => {
    const port = await startServer();
    const id = await createJob(port);

    await rpc(port, 'cron.update', { jobId: id, command: 'from the bar' });
    const { result } = await rpc(port, 'cron.get', { jobId: id });

    expect(result?.message).toBe('from the bar');
  });

  it('refuses to update an id that does not exist, rather than reporting success', async () => {
    const port = await startServer();

    const { error } = await rpc(port, 'cron.update', { jobId: 'ghost', enabled: false });

    expect(error?.message).toMatch(/not found/i);
  });

  it('describes a job the same way in get and list', async () => {
    // Two readers of one job that disagree is how the `command`/`message`
    // split survived as long as it did.
    const port = await startServer();
    const id = await createJob(port);

    const got = (await rpc(port, 'cron.get', { jobId: id })).result;
    const listed = ((await rpc(port, 'cron.list')).result as unknown as { jobs?: unknown[] });
    const fromList = (Array.isArray(listed) ? listed : listed?.jobs ?? [])
      .find((j) => (j as { id?: string }).id === id);

    expect(fromList).toBeDefined();
    expect(Object.keys(got ?? {}).sort()).toEqual(Object.keys(fromList as object).sort());
  });
});
