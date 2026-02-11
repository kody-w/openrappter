/**
 * Cron service types
 */

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  agentId: string;
  message: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CronJobCreate {
  name: string;
  schedule: string;
  agentId?: string;
  message: string;
  enabled?: boolean;
}

export interface CronJobPatch {
  name?: string;
  schedule?: string;
  agentId?: string;
  message?: string;
  enabled?: boolean;
}

export interface CronStatus {
  running: boolean;
  jobCount: number;
  enabledJobCount: number;
  nextJobRun?: string;
  nextJobId?: string;
}

export interface CronRunLog {
  id: string;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'error';
  result?: string;
  error?: string;
}

export type CronEventType = 'job:added' | 'job:updated' | 'job:removed' | 'job:executed' | 'job:error';

export interface CronEvent {
  type: CronEventType;
  jobId: string;
  timestamp: string;
  data?: unknown;
}

export type CronEventHandler = (event: CronEvent) => void;

/**
 * Interface for job execution
 */
export interface JobExecutor {
  execute(agentId: string, message: string): Promise<string>;
}
