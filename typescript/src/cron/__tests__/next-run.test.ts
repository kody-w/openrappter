import { describe, expect, it, vi, afterEach } from 'vitest';
import { CronService, computeNextRun, cronMatchesAt } from '../service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('computeNextRun', () => {
  it('returns the next matching minute, strictly in the future', () => {
    const from = new Date('2026-08-02T10:07:30');
    const next = computeNextRun('*/5 * * * *', from);
    expect(next).toBeDefined();
    expect(new Date(next!).getMinutes()).toBe(10);
    expect(new Date(next!).getTime()).toBeGreaterThan(from.getTime());
  });

  it('does not return the current minute when it already matches', () => {
    // 10:10 matches */5. Standing on it must yield 10:15, not 10:10 again,
    // or a job would re-fire for the minute it just ran.
    const from = new Date('2026-08-02T10:10:00');
    expect(new Date(computeNextRun('*/5 * * * *', from)!).getMinutes()).toBe(15);
  });

  it('rolls across an hour boundary', () => {
    const d = new Date(computeNextRun('*/5 * * * *', new Date('2026-08-02T10:57:00'))!);
    expect([d.getHours(), d.getMinutes()]).toEqual([11, 0]);
  });

  it('handles a daily schedule', () => {
    const d = new Date(computeNextRun('0 9 * * *', new Date('2026-08-02T10:00:00'))!);
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([3, 9, 0]);
  });

  it('returns undefined for an invalid expression rather than throwing', () => {
    expect(computeNextRun('not a cron')).toBeUndefined();
    expect(computeNextRun('* * *')).toBeUndefined();
  });

  it('terminates on an unsatisfiable expression', () => {
    // Feb 30 never occurs; the bounded walk must return, not hang.
    expect(computeNextRun('0 0 30 2 *', new Date('2026-08-02T10:00:00'))).toBeUndefined();
  });

  it('agrees with the matcher it is derived from', () => {
    const next = computeNextRun('*/5 * * * *', new Date('2026-08-02T10:07:00'));
    expect(cronMatchesAt('*/5 * * * *', new Date(next!))).toBe(true);
  });
});

describe('a scheduled job reports when it will next run', () => {
  it('sets nextRun on add, so the listing is not a black box', async () => {
    const svc = new CronService();
    await svc.start();
    const job = await svc.addJob({
      name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check',
    });

    const listed = svc.listJobs().find(j => j.id === job.id)!;
    expect(listed.nextRun).toBeTruthy();
    expect(new Date(listed.nextRun!).getTime()).toBeGreaterThan(Date.now());
    svc.stop();
  });

  it('sets nextRun on jobs restored from disk', async () => {
    const svc = new CronService();
    await svc.start();
    // Shaped exactly like a row in ~/.openrappter/cron.json, which carries no nextRun.
    await svc.loadJobs([{
      id: 'job_daily_tip', name: 'daily-tip', schedule: '0 9 * * *', agentId: 'DailyTip',
      message: 'tip', enabled: true, createdAt: '2026-04-03T14:56:49.083Z',
    }]);

    expect(svc.listJobs().find(j => j.id === 'job_daily_tip')!.nextRun).toBeTruthy();
    svc.stop();
  });

  it('surfaces the soonest run through getStatus', async () => {
    const svc = new CronService();
    await svc.start();
    await svc.addJob({ name: 'soon', schedule: '* * * * *', agentId: 'a', message: 'm' });
    await svc.addJob({ name: 'later', schedule: '0 9 * * *', agentId: 'b', message: 'm' });

    const status = svc.getStatus();
    expect(status.nextJobRun).toBeTruthy();
    expect(status.nextJobId).toBe(svc.listJobs().find(j => j.name === 'soon')!.id);
    svc.stop();
  });

  it('advances nextRun past a completed run', async () => {
    const svc = new CronService();
    await svc.start();
    const job = await svc.addJob({
      name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check',
    });
    const before = svc.getJob(job.id)!.nextRun;

    await svc.executeJob(job.id, 'force');

    const after = svc.getJob(job.id)!;
    expect(after.lastRun).toBeTruthy();
    expect(after.nextRun).toBeTruthy();
    expect(new Date(after.nextRun!).getTime()).toBeGreaterThanOrEqual(new Date(before!).getTime());
    svc.stop();
  });

  it('advances nextRun even when the run fails, so it cannot wedge', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:07:00'));

    const svc = new CronService();
    await svc.start({ execute: async () => { throw new Error('agent exploded'); } });
    const job = await svc.addJob({
      name: 'gv', schedule: '*/5 * * * *', agentId: 'GoogleVoice', message: 'check',
    });
    const before = svc.getJob(job.id)!.nextRun!;

    // Stand past the scheduled slot, then fail the run.
    vi.setSystemTime(new Date(new Date(before).getTime() + 1000));
    expect(await svc.executeJob(job.id, 'force')).toBeNull();

    const after = svc.getJob(job.id)!.nextRun;
    expect(after).toBeTruthy();
    // Must move on. Leaving it parked on a past slot makes due-mode fire forever.
    expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before).getTime());
    svc.stop();
  });

  it("makes 'due' mode reachable — it was dead while nextRun stayed null", async () => {
    const svc = new CronService();
    const ran: string[] = [];
    await svc.start({ execute: async (agentId: string, msg: string) => { ran.push(`${agentId}:${msg}`); return 'ok'; } });
    const job = await svc.addJob({
      name: 'gv', schedule: '* * * * *', agentId: 'GoogleVoice', message: 'check',
    });

    expect(await svc.executeJob(job.id, 'due')).toBeNull();

    const due = svc.getJob(job.id)!;
    vi.setSystemTime(new Date(new Date(due.nextRun!).getTime() + 1000));
    expect(await svc.executeJob(job.id, 'due')).toBe('ok');
    expect(ran).toEqual(['GoogleVoice:check']);
    svc.stop();
  });
});

describe('the scheduler tick stays aligned to the minute', () => {
  it('re-aligns after each tick instead of drifting off a fixed interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:17.000'));

    const svc = new CronService();
    const fired: number[] = [];
    await svc.start({ execute: async () => { fired.push(Date.now()); return 'ok'; } });
    await svc.addJob({ name: 'every-minute', schedule: '* * * * *', agentId: 'a', message: 'm' });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // Every tick must land in its own distinct minute — no skips, no doubles.
    const minutes = fired.map(t => Math.floor(t / 60000));
    expect(new Set(minutes).size).toBe(minutes.length);
    expect(minutes.length).toBeGreaterThanOrEqual(59);

    // And each must land just past the top of the minute, not at :17 forever.
    for (const t of fired) expect(t % 60000).toBeLessThan(2000);
    svc.stop();
  });

  it('recovers alignment after a tick runs late, instead of compounding the lag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000'));

    const svc = new CronService();
    const fired: number[] = [];
    let lateOnce = false;
    await svc.start({
      execute: async () => {
        fired.push(Date.now());
        // One slow run eats 38s of wall clock. A chain that just waits a flat
        // 60s from here would sit at :38 past every following minute forever.
        if (!lateOnce) {
          lateOnce = true;
          vi.setSystemTime(new Date(Date.now() + 38_000));
        }
        return 'ok';
      },
    });
    await svc.addJob({ name: 'every-minute', schedule: '* * * * *', agentId: 'a', message: 'm' });

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    // Ticks after the slow one must be back on the top of the minute.
    const afterLate = fired.slice(2);
    expect(afterLate.length).toBeGreaterThanOrEqual(5);
    for (const t of afterLate) expect(t % 60000).toBeLessThan(2000);

    // And no minute may be skipped.
    const minutes = afterLate.map(t => Math.floor(t / 60000));
    for (let i = 1; i < minutes.length; i++) {
      expect(minutes[i] - minutes[i - 1]).toBe(1);
    }
    svc.stop();
  });
});
