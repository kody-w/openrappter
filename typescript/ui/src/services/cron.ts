/**
 * Cron controller — list, toggle, run, and manage cron jobs.
 */
import type { GatewayClient } from './gateway.js';
import type { CronJob } from '../types.js';

export interface CronState {
  client: GatewayClient | null;
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
}

export function createCronState(): CronState {
  return { client: null, jobs: [], loading: false, error: null };
}

export async function loadCronJobs(state: CronState): Promise<void> {
  if (!state.client?.isConnected) return;
  state.loading = true;
  state.error = null;
  try {
    state.jobs = await state.client.call<CronJob[]>('cron.list');
  } catch (err) {
    state.error = String(err);
    state.jobs = [];
  } finally {
    state.loading = false;
  }
}

export async function toggleCronJob(
  state: CronState,
  jobId: string,
  enabled: boolean,
): Promise<void> {
  if (!state.client?.isConnected) return;
  try {
    await state.client.call('cron.enable', { jobId, enabled });
    state.jobs = state.jobs.map((j) =>
      j.id === jobId ? { ...j, enabled } : j,
    );
  } catch (err) {
    state.error = String(err);
  }
}

export async function runCronJob(
  client: GatewayClient,
  jobId: string,
): Promise<boolean> {
  if (!client.isConnected) return false;
  const res = await client.call<{ triggered: boolean }>('cron.run', { jobId });
  return res.triggered;
}
