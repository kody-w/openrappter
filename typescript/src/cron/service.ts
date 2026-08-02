/**
 * Cron service - manages scheduled jobs
 */

import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronStatus,
  CronRunLog,
  CronEvent,
  CronEventHandler,
  JobExecutor,
} from './types.js';

let idCounter = 0;
function generateId(): string {
  return `job_${Date.now()}_${++idCounter}`;
}

function generateLogId(): string {
  return `log_${Date.now()}_${++idCounter}`;
}

const NAMED_SCHEDULES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
};

export function resolveSchedule(schedule: string): string {
  return NAMED_SCHEDULES[schedule] ?? schedule;
}

/** Check if a single cron field matches a value. */
function fieldMatchesValue(pattern: string, value: number): boolean {
  if (pattern === '*') return true;

  // Step values: */5, 1-10/2
  if (pattern.includes('/')) {
    const [range, stepStr] = pattern.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;
    if (range === '*') return value % step === 0;
    if (range.includes('-')) {
      const [start, end] = range.split('-').map(Number);
      return value >= start && value <= end && (value - start) % step === 0;
    }
    return false;
  }

  if (pattern.includes(',')) {
    return pattern.split(',').some(p => fieldMatchesValue(p.trim(), value));
  }

  if (pattern.includes('-')) {
    const [start, end] = pattern.split('-').map(Number);
    return value >= start && value <= end;
  }

  return parseInt(pattern, 10) === value;
}

/** Does `schedule` match the minute containing `at`? */
export function cronMatchesAt(schedule: string, at: Date): boolean {
  const parts = resolveSchedule(schedule).split(' ').filter(p => p);
  if (parts.length !== 5) return false;
  const fields = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()];
  for (let i = 0; i < 5; i++) {
    if (!fieldMatchesValue(parts[i], fields[i])) return false;
  }
  return true;
}

// A cron expression that matches nothing (Feb 30) must terminate rather than
// spin, so the walk is bounded at just over four years to cover leap days.
const NEXT_RUN_SEARCH_MINUTES = 366 * 4 * 24 * 60;

/**
 * The first minute strictly after `from` whose minute matches `schedule`.
 * Returns undefined for an invalid or unsatisfiable expression.
 */
export function computeNextRun(schedule: string, from: Date = new Date()): string | undefined {
  if (!validateCronExpression(schedule)) return undefined;
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < NEXT_RUN_SEARCH_MINUTES; i++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (cronMatchesAt(schedule, cursor)) return cursor.toISOString();
  }
  return undefined;
}

export function validateCronExpression(expr: string): boolean {
  const resolved = resolveSchedule(expr);
  const parts = resolved.split(' ').filter(p => p);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],  // minute
    [0, 23],  // hour
    [1, 31],  // day of month
    [1, 12],  // month
    [0, 7],   // day of week
  ];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '*') continue;

    // Handle step values like */15
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2));
      if (isNaN(step) || step <= 0) return false;
      continue;
    }

    // Handle ranges like 1-5
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (isNaN(start) || isNaN(end)) return false;
      if (start < ranges[i][0] || end > ranges[i][1]) return false;
      continue;
    }

    // Handle lists like 1,3,5
    if (part.includes(',')) {
      const values = part.split(',').map(Number);
      for (const val of values) {
        if (isNaN(val) || val < ranges[i][0] || val > ranges[i][1]) return false;
      }
      continue;
    }

    // Plain number
    const num = parseInt(part);
    if (isNaN(num) || num < ranges[i][0] || num > ranges[i][1]) return false;
  }

  return true;
}

export class CronService {
  private jobs: Map<string, CronJob> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private runLogs: CronRunLog[] = [];
  private maxLogRetention = 100;
  private running = false;
  private executor: JobExecutor | null = null;
  private eventHandlers: CronEventHandler[] = [];

  async start(executor?: JobExecutor): Promise<void> {
    this.executor = executor ?? null;
    this.running = true;

    // Schedule all enabled jobs
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  async loadJobs(jobs: CronJob[]): Promise<void> {
    for (const job of jobs) {
      this.jobs.set(job.id, job);
      // Jobs restored from disk carry a stale or absent nextRun.
      // addJob defaults enabled to true; a record persisted without the field
      // must load the same way or it comes back silently disabled.
      if (job.enabled === undefined) job.enabled = true;
      if (this.running && job.enabled) this.scheduleJob(job);
      else job.nextRun = job.enabled ? computeNextRun(job.schedule) : undefined;
    }
  }

  async addJob(input: CronJobCreate): Promise<CronJob> {
    const now = new Date().toISOString();
    const job: CronJob = {
      id: generateId(),
      name: input.name,
      schedule: input.schedule,
      agentId: input.agentId ?? 'main',
      message: input.message,
      enabled: input.enabled ?? true,
      createdAt: now,
    };

    this.jobs.set(job.id, job);

    if (this.running && job.enabled) {
      this.scheduleJob(job);
    }

    this.emit({ type: 'job:added', jobId: job.id, timestamp: now });
    return job;
  }

  async updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;

    const updated: CronJob = {
      ...job,
      ...patch,
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(id, updated);

    // Reschedule if schedule or enabled changed
    if (patch.schedule !== undefined || patch.enabled !== undefined) {
      this.unscheduleJob(id);
      if (this.running && updated.enabled) {
        this.scheduleJob(updated);
      }
    }

    this.emit({ type: 'job:updated', jobId: id, timestamp: updated.updatedAt! });
    return updated;
  }

  async removeJob(id: string): Promise<boolean> {
    const existed = this.jobs.delete(id);
    if (existed) {
      this.unscheduleJob(id);
      this.emit({ type: 'job:removed', jobId: id, timestamp: new Date().toISOString() });
    }
    return existed;
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  listEnabledJobs(): CronJob[] {
    return this.listJobs().filter(j => j.enabled);
  }

  async executeJob(id: string, mode: 'due' | 'force' = 'due'): Promise<string | null> {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (mode === 'due') {
      if (!job.nextRun || new Date(job.nextRun) > new Date()) {
        return null;
      }
    }

    const logEntry: CronRunLog = {
      id: generateLogId(),
      jobId: id,
      startedAt: new Date().toISOString(),
      status: 'running',
    };

    this.addLog(logEntry);

    try {
      let result: string;
      if (this.executor) {
        result = await this.executor.execute(job.agentId, job.message);
      } else {
        result = `Executed: ${job.message}`;
      }

      logEntry.status = 'success';
      logEntry.result = result;
      logEntry.completedAt = new Date().toISOString();

      // Update job timestamps
      job.lastRun = logEntry.completedAt;
      job.nextRun = computeNextRun(job.schedule);
      this.jobs.set(id, job);

      this.emit({ type: 'job:executed', jobId: id, timestamp: logEntry.completedAt, data: { result } });
      return result;
    } catch (err) {
      logEntry.status = 'error';
      logEntry.error = err instanceof Error ? err.message : String(err);
      logEntry.completedAt = new Date().toISOString();
      // A failed run must still advance, or a due-mode caller retries forever.
      job.lastRun = logEntry.completedAt;
      job.nextRun = computeNextRun(job.schedule);
      this.jobs.set(id, job);

      this.emit({ type: 'job:error', jobId: id, timestamp: logEntry.completedAt, data: { error: logEntry.error } });
      return null;
    }
  }

  getStatus(): CronStatus {
    const jobs = this.listJobs();
    const enabledJobs = jobs.filter(j => j.enabled);

    // Find next scheduled job
    let nextJobRun: string | undefined;
    let nextJobId: string | undefined;

    for (const job of enabledJobs) {
      if (job.nextRun && (!nextJobRun || job.nextRun < nextJobRun)) {
        nextJobRun = job.nextRun;
        nextJobId = job.id;
      }
    }

    return {
      running: this.running,
      jobCount: jobs.length,
      enabledJobCount: enabledJobs.length,
      nextJobRun,
      nextJobId,
    };
  }

  getRunLogs(jobId?: string): CronRunLog[] {
    if (jobId) {
      return this.runLogs.filter(l => l.jobId === jobId);
    }
    return [...this.runLogs];
  }

  onEvent(handler: CronEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  private scheduleJob(job: CronJob): void {
    job.nextRun = computeNextRun(job.schedule);
    this.jobs.set(job.id, job);

    const tick = (): void => {
      if (job.enabled && this.cronMatches(job.schedule)) {
        this.executeJob(job.id, 'force').catch(() => {});
      } else {
        // Keep nextRun truthful even on minutes that do not fire.
        job.nextRun = computeNextRun(job.schedule);
        this.jobs.set(job.id, job);
      }
    };

    // A bare 60s interval drifts off the minute it was started on and can skip a
    // target minute entirely. Re-align to just past the top of each minute.
    const alignAndRun = (): void => {
      tick();
      const delay = 60000 - (Date.now() % 60000) + 500;
      const t = setTimeout(alignAndRun, delay);
      if (typeof t.unref === 'function') t.unref();
      this.timers.set(job.id, t);
    };

    const firstDelay = 60000 - (Date.now() % 60000) + 500;
    const timer = setTimeout(alignAndRun, firstDelay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(job.id, timer);
  }

  /** Check if a cron expression matches the current time (minute-level precision) */
  private cronMatches(schedule: string): boolean {
    return cronMatchesAt(schedule, new Date());
  }

  private unscheduleJob(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private addLog(entry: CronRunLog): void {
    this.runLogs.push(entry);
    if (this.runLogs.length > this.maxLogRetention) {
      this.runLogs.shift();
    }
  }

  private emit(event: CronEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}
