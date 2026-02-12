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
}
