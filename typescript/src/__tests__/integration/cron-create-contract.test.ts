import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GatewayServer } from '../../gateway/server.js';
import { CronService } from '../../cron/service.js';
import { createCronGatewayAdapter } from '../../cron/gateway-adapter.js';

/**
 * Binds the macOS Bar's cron payload to the handler that actually runs.
 *
 * `RpcClient.createCronJob` sent `{ name, schedule, command }`. Everything on
 * the gateway side calls that field `message` — `CronJobCreate.message`, the
 * scheduler, and the executor signature `execute(agentId, message)`. So the
 * daemon's `setCronService({ add })` read `String(job.message ?? '')`, the job
 * was created and scheduled, `cron.create` answered `{ scheduled: true }`, and
 * the job then fired on its cron expression with an empty prompt forever.
 *
 * These tests go over real HTTP to a real `GatewayServer` with a real
 * `CronService` wired exactly as `typescript/src/index.ts` wires it.
 * `typescript/src/gateway/methods/cron-methods.ts` is deliberately never
 * registered (see the doc comment on `registerBuiltinMethods`), so a test that
 * imported it would prove nothing about production — that module has its own
 * `action` dialect and would have passed throughout the defect's lifetime.
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

/** Wires CronService into GatewayServer with the daemon's own adapter. */
async function startServer(): Promise<{ port: number; service: CronService; fired: string[] }> {
  dataDir = mkdtempSync(join(tmpdir(), 'cron-contract-'));

  const fired: string[] = [];
  const service = new CronService();
  await service.start({
    execute: async (agentId: string, message: string) => {
      fired.push(`${agentId}:${message}`);
      return 'ok';
    },
  });
  cron = service;

  server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
  await server.start();
  const port = server.port;
  server.setCronService(createCronGatewayAdapter({ service, persist: () => {} }));

  return { port, service, fired };
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

/** Exactly the params `RpcClient.createCronJob` builds, before this fix. */
function legacyBarPayload(command: string) {
  return { name: 'bar job', schedule: '* * * * *', command };
}

/** Exactly the params `RpcClient.createCronJob` builds now. */
function barPayload(message: string) {
  return { name: 'bar job', schedule: '* * * * *', message };
}

describe('cron.create contract, against the wired gateway', () => {
  it('a job created by an older Bar carries its prompt into the live scheduler', async () => {
    const { port, service } = await startServer();

    const { error } = await rpc(port, 'cron.create', legacyBarPayload('summarise my inbox'));

    expect(error).toBeUndefined();
    const [job] = service.listJobs();
    expect(job, 'the job must reach the live scheduler at all').toBeDefined();
    expect(job.message).toBe('summarise my inbox');
  });

  it('a job created by an older Bar fires with its prompt, not an empty one', async () => {
    const { port, service, fired } = await startServer();

    await rpc(port, 'cron.create', legacyBarPayload('check google voice'));
    await service.executeJob(service.listJobs()[0].id, 'force');

    // The whole symptom: it ran, on time, saying nothing.
    expect(fired).toEqual(['main:check google voice']);
  });

  it('the current Bar payload names the field `message`', async () => {
    const { port, service } = await startServer();

    const { error } = await rpc(port, 'cron.create', barPayload('summarise my inbox'));

    expect(error).toBeUndefined();
    expect(service.listJobs()[0].message).toBe('summarise my inbox');
  });

  it('`message` wins when a client sends both spellings', async () => {
    const { port, service } = await startServer();

    await rpc(port, 'cron.create', {
      name: 'bar job', schedule: '* * * * *', message: 'canonical', command: 'legacy',
    });

    expect(service.listJobs()[0].message).toBe('canonical');
  });

  it('stores one spelling, so a persisted job cannot disagree with itself', async () => {
    const { port } = await startServer();

    const { result } = await rpc(port, 'cron.create', legacyBarPayload('summarise my inbox'));

    expect(result?.message).toBe('summarise my inbox');
    expect(result, 'the legacy alias must not survive into the record').not.toHaveProperty('command');
  });

  it('refuses a job with no prompt in any accepted spelling', async () => {
    const { port, service } = await startServer();

    const { error } = await rpc(port, 'cron.create', { name: 'bar job', schedule: '* * * * *' });

    expect(error?.message).toMatch(/non-empty `message`/);
    expect(service.listJobs(), 'nothing may be scheduled').toHaveLength(0);
  });

  it('refuses a blank prompt, which schedules a job that does nothing', async () => {
    const { port, service } = await startServer();

    const { error } = await rpc(port, 'cron.create', legacyBarPayload('   '));

    expect(error?.message).toMatch(/non-empty `message`/);
    expect(service.listJobs()).toHaveLength(0);
  });

  it('cron.add refuses the same way — it is the same handler', async () => {
    const { port } = await startServer();

    const { error } = await rpc(port, 'cron.add', { name: 'x', schedule: '* * * * *' });

    expect(error?.message).toMatch(/non-empty `message`/);
  });

  it('refuses before touching the file store, so no half-written job survives', async () => {
    // No cron service: the file-backed fallback path.
    dataDir = mkdtempSync(join(tmpdir(), 'cron-contract-'));
    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
    await server.start();
    const port = server.port;

    const { error } = await rpc(port, 'cron.add', { name: 'x', schedule: '* * * * *' });
    expect(error?.message).toMatch(/non-empty `message`/);

    const { result } = await rpc(port, 'cron.list');
    expect(result).toEqual([]);
  });

  it('the file-only fallback normalises the legacy spelling too', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cron-contract-'));
    server = new GatewayServer({ port: 0, bind: 'loopback', auth: { mode: 'none' }, dataDir });
    await server.start();
    const port = server.port;

    await rpc(port, 'cron.create', legacyBarPayload('from an old bar'));

    const { result } = await rpc(port, 'cron.list');
    const jobs = result as unknown as Record<string, unknown>[];
    expect(jobs[0].message).toBe('from an old bar');
  });
});

describe('cron.list answers in the same field name it accepts', () => {
  it('round-trips `message`, and keeps `command` for the Bar that reads it', async () => {
    const { port } = await startServer();
    await rpc(port, 'cron.create', barPayload('summarise my inbox'));

    const { result } = await rpc(port, 'cron.list');
    const jobs = result as unknown as Record<string, unknown>[];

    expect(jobs[0].message).toBe('summarise my inbox');
    expect(jobs[0].command).toBe('summarise my inbox');
  });
});
