/**
 * `openrappter cron add` has to speak the daemon's parameter names.
 *
 * It did not. The CLI sent `{ schedule, action, description }`; the gateway
 * bridge reads `{ name, schedule, message, agentId }`. Nothing errored — the
 * daemon just saw no message and no agent, and created a job named "job" that
 * ran the main assistant with an empty prompt on the schedule you asked for.
 *
 * So the documented way to register the Google Voice wake-up could not register
 * it. These tests pin the wire shape, because that mismatch is invisible from
 * either side alone.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

// The command builds its own RpcClient, so the socket is what gets stubbed.
vi.mock('../rpc-client.js', () => ({
  RpcClient: class {
    async connect(): Promise<void> {}
    disconnect(): void {}
    async call(method: string, params: Record<string, unknown>): Promise<unknown> {
      calls.push({ method, params });
      return { id: 'job_test', scheduled: true };
    }
  },
}));

async function runCron(argv: string[]): Promise<void> {
  const { registerCronCommand } = await import('../cron.js');
  const program = new Command();
  program.exitOverride();
  registerCronCommand(program);
  await program.parseAsync(['node', 'openrappter', 'cron', ...argv]);
}

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('cron add sends what the gateway actually reads', () => {
  it('sends the action as `message`, not as `action`', async () => {
    await runCron(['add', '*/5 * * * *', 'check']);

    const { params } = calls.find(c => c.method === 'cron.add')!;
    expect(params.message).toBe('check');
    expect(params.schedule).toBe('*/5 * * * *');
  });

  it('sends the agent as `agentId`, so a job can target GoogleVoice', async () => {
    await runCron(['add', '*/5 * * * *', 'check', '--agent', 'GoogleVoice']);

    const { params } = calls.find(c => c.method === 'cron.add')!;
    expect(params.agentId).toBe('GoogleVoice');
  });

  it('names the job, so `cron list` is readable', async () => {
    await runCron(['add', '*/5 * * * *', 'check', '--name', 'Google Voice check']);

    expect(calls.find(c => c.method === 'cron.add')!.params.name).toBe('Google Voice check');
  });

  it('falls back to the action for a name rather than sending none', async () => {
    await runCron(['add', '0 9 * * *', 'send the morning brief']);

    expect(calls.find(c => c.method === 'cron.add')!.params.name).toBe('send the morning brief');
  });

  it('registers the documented Google Voice job exactly as the README shows', async () => {
    await runCron([
      'add', '*/5 * * * *', 'check', '--agent', 'GoogleVoice', '--name', 'Google Voice check',
    ]);

    expect(calls.find(c => c.method === 'cron.add')!.params).toMatchObject({
      name: 'Google Voice check',
      schedule: '*/5 * * * *',
      message: 'check',
      agentId: 'GoogleVoice',
    });
  });

  describe('cron job actions send the identifier the gateway actually reads', () => {
    it.each(['remove', 'run'])('sends `jobId` for cron %s', async (action) => {
      await runCron([action, 'job-7']);

      expect(calls.find(c => c.method === `cron.${action}`)!.params).toEqual({
        jobId: 'job-7',
      });
    });

    it('sends `jobId` and the requested state for cron enable', async () => {
      await runCron(['enable', 'job-7', '--disable']);

      expect(calls.find(c => c.method === 'cron.enable')!.params).toEqual({
        jobId: 'job-7',
        enabled: false,
      });
    });
  });
});
