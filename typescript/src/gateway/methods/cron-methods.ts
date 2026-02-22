/**
 * Cron scheduling RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface CronJob {
  id: string;
  schedule: string;
  action: string;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
}

interface CronRunLog {
  jobId: string;
  timestamp: number;
  success: boolean;
  duration: number;
  error?: string;
}

interface CronService {
  updateJob(
    id: string,
    updates: Partial<Omit<CronJob, 'id'>>
  ): Promise<CronJob>;
  getStatus(): {
    running: boolean;
    jobCount: number;
    nextRun?: number;
  };
  getRecentRuns(limit?: number): CronRunLog[];
}

interface CronMethodsDeps {
  cronService?: CronService;
}

export function registerCronMethods(
  server: MethodRegistrar,
  deps?: CronMethodsDeps
): void {
  server.registerMethod<
    { id: string; updates: Partial<Omit<CronJob, 'id'>> },
    { job: CronJob }
  >('cron.update', async (params) => {
    const service = deps?.cronService;

    if (!service) {
      throw new Error('Cron service not available');
    }

    const job = await service.updateJob(params.id, params.updates);

    return { job };
  });

  server.registerMethod<
    void,
    { running: boolean; jobCount: number; nextRun?: number }
  >('cron.status', async () => {
    const service = deps?.cronService;

    if (!service) {
      return { running: false, jobCount: 0 };
    }

    return service.getStatus();
  });

  server.registerMethod<{ limit?: number }, { runs: CronRunLog[] }>(
    'cron.runs',
    async (params) => {
      const service = deps?.cronService;

      if (!service) {
        return { runs: [] };
      }

      const runs = service.getRecentRuns(params.limit);

      return { runs };
    }
  );

  // ── Dashboard CRUD methods (local cronStore) ──

  const cronStore: Array<Record<string, unknown>> = [];

  // List all cron jobs
  server.registerMethod<void, Array<Record<string, unknown>>>(
    'cron.list',
    async () => {
      return cronStore;
    }
  );

  // Add a cron job
  server.registerMethod<Record<string, unknown>, Record<string, unknown>>(
    'cron.add',
    async (params) => {
      const job = {
        id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...params,
      };
      cronStore.push(job);
      return job;
    }
  );

  // Enable/disable a cron job
  server.registerMethod<{ jobId: string; enabled: boolean }, { enabled: boolean }>(
    'cron.enable',
    async (params) => {
      const job = cronStore.find((j) => j.id === params.jobId);
      if (job) {
        job.enabled = params.enabled;
        return { enabled: params.enabled };
      }
      throw new Error('Job not found');
    }
  );

  // Trigger a cron job
  server.registerMethod<{ jobId: string }, { triggered: boolean }>(
    'cron.run',
    async (params) => {
      const job = cronStore.find((j) => j.id === params.jobId);
      if (!job) throw new Error('Job not found');
      job.lastRun = Date.now();
      return { triggered: true };
    }
  );

  // Remove a cron job
  server.registerMethod<{ jobId: string }, { removed: boolean }>(
    'cron.remove',
    async (params) => {
      const idx = cronStore.findIndex((j) => j.id === params.jobId);
      if (idx >= 0) {
        cronStore.splice(idx, 1);
        return { removed: true };
      }
      return { removed: false };
    }
  );
}
