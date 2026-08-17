/**
 * A cron job added at runtime has to actually run.
 *
 * The defect: `cron.add` pushed onto `cronStore` (a JSON file) while `cron.list`
 * read from `cronService` (the running scheduler). Adding a job returned a
 * populated object and wrote it to disk, then it vanished from the listing and
 * never fired — it looked accepted and did nothing until the daemon restarted.
 *
 * Found while wiring the Google Voice wake-up: the job was created, came back
 * with an id, and was simply not there when the schedule was listed.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayServer } from '../server.js';
import { CronService } from '../../cron/service.js';

type Handler = (params: unknown, connection: unknown) => Promise<unknown>;

/** Handlers are registered in start(), so the server has to be started. */
function methodsOf(server: GatewayServer): Map<string, { handler: Handler }> {
  return (server as unknown as { methods: Map<string, { handler: Handler }> }).methods;
}

const started: GatewayServer[] = [];
const tempDirs: string[] = [];
async function boot(): Promise<GatewayServer> {
  // A dataDir per server. Without it the gateway defaults to ~/.openrappter and
  // these tests persist junk cron jobs into the real user's data.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openrappter-cron-test-'));
  tempDirs.push(dataDir);
  // Port 0 lets the OS pick a free one, so parallel test files cannot collide.
  const server = new GatewayServer({ port: 0, dataDir });
  await server.start();
  started.push(server);
  return server;
}
afterEach(async () => {
  while (started.length) await started.pop()!.stop().catch(() => {});
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('the test harness itself', () => {
  it('never writes to the real ~/.openrappter data directory', async () => {
    const real = path.join(os.homedir(), '.openrappter');
    const server = await boot();
    const dir = (server as unknown as { config: { dataDir?: string } }).config.dataDir;
    expect(dir).toBeDefined();
    expect(dir).not.toBe(real);
    expect(dir!.startsWith(os.tmpdir()) || dir!.startsWith('/private' + os.tmpdir())).toBe(true);
  });
});

function fakeScheduler() {
  const jobs: Array<Record<string, unknown>> = [];
  return {
    jobs,
    service: {
      list: () => jobs.map((j) => ({
        id: String(j.id), name: String(j.name ?? ''),
        schedule: String(j.schedule ?? ''), enabled: j.enabled !== false,
      })),
      run: async () => {},
      enable: async (id: string) => { const j = jobs.find(x => x.id === id); if (j) j.enabled = true; },
      disable: async (id: string) => { const j = jobs.find(x => x.id === id); if (j) j.enabled = false; },
      add: async (job: Record<string, unknown>) => {
        const id = `cron_${jobs.length + 1}`;
        jobs.push({ ...job, id });
        return { id };
      },
      remove: async (id: string) => {
        const i = jobs.findIndex((j) => j.id === id);
        if (i >= 0) jobs.splice(i, 1);
      },
    },
  };
}

describe('cron.add reaches the running scheduler', () => {
  it('adds the job to the live scheduler, not just a file', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service);

    const methods = methodsOf(server);
    const add = methods.get('cron.add')!.handler;
    const list = methods.get('cron.list')!.handler;

    const created = (await add(
      { name: 'Google Voice check', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check' },
      null,
    )) as Record<string, unknown>;

    expect(created.id).toBeTruthy();
    expect(created.scheduled, 'must report that it really scheduled').toBe(true);

    // THE ONE THAT MATTERS: it has to come back from the listing.
    const listed = (await list({}, null)) as Array<{ id: string }>;
    expect(listed.map((j) => j.id)).toContain(String(created.id));
    expect(sched.jobs, 'the scheduler itself must hold it').toHaveLength(1);
  });

  it('removing a job removes it from the scheduler too', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service);
    const methods = methodsOf(server);

    const created = (await methods.get('cron.add')!.handler(
      { name: 'temp', schedule: '* * * * *', message: 'x' }, null,
    )) as Record<string, unknown>;
    await methods.get('cron.remove')!.handler({ jobId: String(created.id) }, null);
    expect(sched.jobs).toHaveLength(0);
  });

  it('does not report success for a job that does not exist', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);

    await expect(
      methodsOf(server).get('cron.remove')!.handler(
        { jobId: 'no-such-job' },
        null,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('does not report success when the client sends no job id', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);

    await expect(
      methodsOf(server).get('cron.remove')!.handler({ jobId: '' }, null),
    ).rejects.toThrow(/not found/i);
  });

  // Older hosts wire no scheduler. Saving to disk is still useful, but the
  // caller must not be told it was scheduled when it was not.
  it('says so plainly when it could only reach the file', async () => {
    const server = await boot();
    const methods = methodsOf(server);
    const created = (await methods.get('cron.add')!.handler(
      { name: 'orphan', schedule: '* * * * *', message: 'x' }, null,
    )) as Record<string, unknown>;
    expect(created.scheduled).toBe(false);
    expect(String(created.note)).toMatch(/restart/i);
  });
});

describe('cron.create is an alias, not a second implementation', () => {
  it('reaches the live scheduler too — it kept the bug after cron.add was fixed', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service as never);

    const res = await methodsOf(server).get('cron.create')!.handler(
      { name: 'from-menu-bar', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check' },
      {} as never,
    ) as { scheduled: boolean };

    expect(res.scheduled).toBe(true);
    expect(sched.jobs).toHaveLength(1);
    expect(sched.jobs[0]).toMatchObject({ name: 'from-menu-bar', agentId: 'GoogleVoice' });
  });
});

describe('cron.delete is an alias, not a second implementation', () => {
  // The menu bar deletes through `cron.delete`. That alias filtered the JSON
  // file store and returned { removed: true } without ever telling the running
  // scheduler — the user was told the job was gone and it kept firing.
  it('removes the job from the live scheduler, not just the file', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service as never);
    const methods = methodsOf(server);

    const created = await methods.get('cron.add')!.handler(
      { name: 'from-menu-bar', schedule: '* * * * *', agentId: 'GoogleVoice', message: 'check' },
      {} as never,
    ) as { id: string };
    expect(sched.jobs).toHaveLength(1);

    // Exactly the payload RpcClient.deleteCronJob sends.
    const res = await methods.get('cron.delete')!.handler({ jobId: created.id }, {} as never);

    expect(res).toMatchObject({ removed: true });
    expect(sched.jobs, 'the scheduler itself must no longer hold it').toHaveLength(0);
    expect(sched.service.list().map(j => j.id)).not.toContain(created.id);
  });

  it('refuses an unknown job id instead of reporting a successful delete', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);
    await expect(
      methodsOf(server).get('cron.delete')!.handler({ jobId: 'no-such-job' }, {} as never),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses an empty job id', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);
    await expect(
      methodsOf(server).get('cron.delete')!.handler({ jobId: '' }, {} as never),
    ).rejects.toThrow(/not found/i);
  });

  it('is literally the same handler as cron.remove, so it cannot drift again', async () => {
    const server = await boot();
    const methods = methodsOf(server);
    expect(methods.get('cron.delete')!.handler).toBe(methods.get('cron.remove')!.handler);
  });

  // The symptom the user reports: not "it is still listed" but "it still ran".
  it('stops the real CronService job from firing again', async () => {
    const server = await boot();
    const cron = new CronService();
    const fired: string[] = [];
    await cron.start({ execute: async (agentId, message) => { fired.push(`${agentId}:${message}`); return 'ok'; } });
    // Wired exactly as the daemon wires it (src/index.ts).
    server.setCronService({
      list: () => cron.listJobs().map(j => ({ id: j.id, name: j.name, schedule: j.schedule, enabled: j.enabled })),
      run: async (id: string) => { await cron.executeJob(id, 'force'); },
      enable: async (id: string) => { await cron.updateJob(id, { enabled: true }); },
      disable: async (id: string) => { await cron.updateJob(id, { enabled: false }); },
      add: async (job: Record<string, unknown>) => {
        const created = await cron.addJob({
          name: String(job.name ?? 'job'), schedule: String(job.schedule ?? '* * * * *'),
          agentId: job.agentId ? String(job.agentId) : undefined, message: String(job.message ?? ''),
          enabled: job.enabled !== false,
        });
        return { id: created.id };
      },
      remove: async (id: string) => { await cron.removeJob(id); },
    });
    const methods = methodsOf(server);

    const created = await methods.get('cron.add')!.handler(
      { name: 'every minute', schedule: '* * * * *', agentId: 'ReproAgent', message: 'ping' },
      {} as never,
    ) as { id: string };
    // Sanity: before the delete it does fire when its minute comes up. This is
    // the same call the scheduler's timer makes on a matching minute.
    expect(await cron.executeJob(created.id, 'force')).toBe('ok');
    expect(fired).toHaveLength(1);

    await methods.get('cron.delete')!.handler({ jobId: created.id }, {} as never);

    // Now the scheduler tick has nothing left to run.
    expect(await cron.executeJob(created.id, 'force')).toBeNull();
    expect(fired, 'a deleted job must not fire again').toHaveLength(1);
    expect(cron.listJobs()).toHaveLength(0);
    cron.stop();
  });

  // Hosts with no live scheduler still delete from the file store.
  it('still removes a file-only job when no scheduler is wired', async () => {
    const server = await boot();
    const methods = methodsOf(server);
    const created = await methods.get('cron.add')!.handler(
      { name: 'orphan', schedule: '* * * * *', message: 'x' }, {} as never,
    ) as { id: string };

    await methods.get('cron.delete')!.handler({ jobId: created.id }, {} as never);

    const listed = await methods.get('cron.list')!.handler({}, {} as never) as Array<{ id: string }>;
    expect(listed.map(j => j.id)).not.toContain(created.id);
  });
});

describe('a job added without an explicit enabled flag', () => {
  it('is persisted as enabled, so it does not round-trip back as disabled', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service as never);

    await methodsOf(server).get('cron.add')!.handler(
      { name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check' },
      {} as never,
    );

    expect(sched.jobs[0]).toMatchObject({ enabled: true });
  });

  it('still honours an explicit enabled: false', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service as never);

    await methodsOf(server).get('cron.add')!.handler(
      { name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check', enabled: false },
      {} as never,
    );

    expect(sched.jobs[0]).toMatchObject({ enabled: false });
  });
});

describe('cron.enable acts on the job that is actually running', () => {
  it('disables through the live scheduler, not just the file', async () => {
    const server = await boot();
    const sched = fakeScheduler();
    server.setCronService(sched.service as never);
    const created = await methodsOf(server).get('cron.add')!.handler(
      { name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check' },
      {} as never,
    ) as { id: string };

    await methodsOf(server).get('cron.enable')!.handler(
      { jobId: created.id, enabled: false }, {} as never,
    );

    // The scheduler must have been told. Flipping only the file left the job
    // firing every five minutes while the API reported it disabled.
    expect(sched.service.list().find(j => j.id === created.id)!.enabled).toBe(false);
  });

  it('refuses an unknown job id instead of reporting success', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);
    await expect(
      methodsOf(server).get('cron.enable')!.handler({ jobId: 'no-such-job', enabled: false }, {} as never),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses an empty job id — that silently "succeeded" while the job ran on', async () => {
    const server = await boot();
    server.setCronService(fakeScheduler().service as never);
    await expect(
      methodsOf(server).get('cron.enable')!.handler({ jobId: '', enabled: false }, {} as never),
    ).rejects.toThrow(/not found/i);
  });
});
