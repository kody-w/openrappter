/**
 * The adapter the daemon hands to `GatewayServer.setCronService`.
 *
 * This lived inline in `src/index.ts`, which is a process entry point and
 * cannot be imported by a test. That mattered: the mapping in here is one half
 * of the client/server field contract — it decides that the scheduler is fed
 * `job.message`, and that a listing reports `message`/`command`. The macOS Bar
 * sent `command` on create, this side read `message`, and nothing anywhere
 * could observe the disagreement because no test could reach this code.
 *
 * It is a module now so a contract test can drive the real thing.
 */
import type { CronService } from './service.js';
import type { CronJob } from './types.js';

/** The subset of CronService this adapter needs, so tests can supply a real one. */
type SchedulerLike = Pick<
  CronService,
  'listJobs' | 'executeJob' | 'updateJob' | 'getRunLogs' | 'addJob' | 'removeJob' | 'getJob'
>;

export interface CronGatewayAdapterOptions {
  service: SchedulerLike;
  /** Write the scheduler's jobs back to disk; a job that only runs now vanishes on restart. */
  persist: () => void;
}

/** One shape for a job on the wire, so `list` and `get` cannot disagree. */
function onTheWire(j: CronJob) {
  return {
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    enabled: j.enabled,
    // `message` is the canonical name on the wire. `command` is emitted
    // alongside it because the macOS Bar reads that spelling; answering only
    // in `command` was the read half of the same disagreement that made
    // `cron.create` drop the Bar's prompt on the floor.
    message: j.message || '',
    command: j.message || '',
    agentId: j.agentId || '',
    lastRun: j.lastRun || null,
    nextRun: j.nextRun || null,
  };
}

export function createCronGatewayAdapter({ service, persist }: CronGatewayAdapterOptions) {
  return {
    list: () => service.listJobs().map(onTheWire),
    // Without this the gateway read only its file fallback, so a job the
    // scheduler had just created and confirmed was reported as not found.
    get: (id: string) => {
      const job = service.getJob(id);
      return job ? onTheWire(job) : undefined;
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const updated = await service.updateJob(id, patch);
      if (!updated) return undefined;
      persist();
      return onTheWire(updated);
    },
    run: async (id: string) => { await service.executeJob(id, 'force'); },
    enable: async (id: string) => { await service.updateJob(id, { enabled: true }); persist(); },
    disable: async (id: string) => { await service.updateJob(id, { enabled: false }); persist(); },
    getRunLogs: (jobId?: string) => service.getRunLogs(jobId),
    add: async (job: Record<string, unknown>) => {
      // `message` only: the gateway normalises the macOS Bar's legacy
      // `command` spelling before it ever gets here (see `addCronJob` in
      // gateway/server.ts), so there is exactly one place that knows about it.
      const created = await service.addJob({
        name: String(job.name ?? 'job'),
        schedule: String(job.schedule ?? '*/5 * * * *'),
        agentId: job.agentId ? String(job.agentId) : undefined,
        message: String(job.message ?? ''),
        enabled: job.enabled !== false,
      });
      persist();
      return { id: created.id };
    },
    remove: async (id: string) => { await service.removeJob(id); persist(); },
  };
}
