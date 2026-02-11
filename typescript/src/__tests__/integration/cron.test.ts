/**
 * Cron Integration Tests
 * Tests with real CronService:
 * - Add/remove/list jobs
 * - Cron expression validation
 * - Named schedules (@hourly, @daily, etc.)
 * - Job enable/disable
 * - Run log tracking
 * - Event system
 * - Force execution
 */

import { describe, it, expect, afterEach } from 'vitest';
import { CronService, validateCronExpression, resolveSchedule } from '../../cron/service.js';

describe('Cron Integration', () => {
  let service: CronService;

  afterEach(() => {
    service?.stop();
  });

  // ── validateCronExpression ────────────────────────────────────────────

  describe('validateCronExpression', () => {
    it('should accept valid 5-part cron expressions', () => {
      expect(validateCronExpression('* * * * *')).toBe(true);
      expect(validateCronExpression('0 * * * *')).toBe(true);
      expect(validateCronExpression('*/15 * * * *')).toBe(true);
      expect(validateCronExpression('0 0 * * *')).toBe(true);
      expect(validateCronExpression('0 0 1 * *')).toBe(true);
      expect(validateCronExpression('30 14 * * 1-5')).toBe(true);
    });

    it('should accept named schedules', () => {
      expect(validateCronExpression('@hourly')).toBe(true);
      expect(validateCronExpression('@daily')).toBe(true);
      expect(validateCronExpression('@weekly')).toBe(true);
      expect(validateCronExpression('@monthly')).toBe(true);
      expect(validateCronExpression('@yearly')).toBe(true);
    });

    it('should reject invalid expressions', () => {
      expect(validateCronExpression('')).toBe(false);
      expect(validateCronExpression('* *')).toBe(false);
      expect(validateCronExpression('60 * * * *')).toBe(false);
      expect(validateCronExpression('* 25 * * *')).toBe(false);
      expect(validateCronExpression('* * 32 * *')).toBe(false);
      expect(validateCronExpression('* * * 13 *')).toBe(false);
    });

    it('should accept list values', () => {
      expect(validateCronExpression('0,15,30,45 * * * *')).toBe(true);
      expect(validateCronExpression('* * * * 1,3,5')).toBe(true);
    });

    it('should accept range values', () => {
      expect(validateCronExpression('* 9-17 * * *')).toBe(true);
      expect(validateCronExpression('* * * * 1-5')).toBe(true);
    });

    it('should accept step values', () => {
      expect(validateCronExpression('*/5 * * * *')).toBe(true);
      expect(validateCronExpression('*/10 * * * *')).toBe(true);
    });
  });

  // ── resolveSchedule ───────────────────────────────────────────────────

  describe('resolveSchedule', () => {
    it('should resolve named schedules', () => {
      expect(resolveSchedule('@hourly')).toBe('0 * * * *');
      expect(resolveSchedule('@daily')).toBe('0 0 * * *');
      expect(resolveSchedule('@weekly')).toBe('0 0 * * 0');
      expect(resolveSchedule('@monthly')).toBe('0 0 1 * *');
      expect(resolveSchedule('@yearly')).toBe('0 0 1 1 *');
    });

    it('should pass through regular expressions', () => {
      expect(resolveSchedule('*/5 * * * *')).toBe('*/5 * * * *');
    });
  });

  // ── CronService Job Management ────────────────────────────────────────

  describe('CronService', () => {
    it('should add a job', async () => {
      service = new CronService();
      const job = await service.addJob({
        name: 'test-job',
        schedule: '*/5 * * * *',
        message: 'Run health check',
      });

      expect(job.id).toBeDefined();
      expect(job.name).toBe('test-job');
      expect(job.schedule).toBe('*/5 * * * *');
      expect(job.enabled).toBe(true);
      expect(job.agentId).toBe('main');
    });

    it('should list jobs', async () => {
      service = new CronService();
      await service.addJob({ name: 'j1', schedule: '@hourly', message: 'msg1' });
      await service.addJob({ name: 'j2', schedule: '@daily', message: 'msg2' });

      const jobs = service.listJobs();
      expect(jobs).toHaveLength(2);
    });

    it('should get a specific job', async () => {
      service = new CronService();
      const job = await service.addJob({ name: 'specific', schedule: '@hourly', message: 'hi' });

      const found = service.getJob(job.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe('specific');
    });

    it('should remove a job', async () => {
      service = new CronService();
      const job = await service.addJob({ name: 'remove-me', schedule: '@hourly', message: 'msg' });

      const removed = await service.removeJob(job.id);
      expect(removed).toBe(true);
      expect(service.getJob(job.id)).toBeUndefined();
    });

    it('should return false when removing non-existent job', async () => {
      service = new CronService();
      expect(await service.removeJob('nonexistent')).toBe(false);
    });

    it('should update a job', async () => {
      service = new CronService();
      const job = await service.addJob({ name: 'update-me', schedule: '@hourly', message: 'old' });

      const updated = await service.updateJob(job.id, { message: 'new', enabled: false });
      expect(updated).not.toBeNull();
      expect(updated!.message).toBe('new');
      expect(updated!.enabled).toBe(false);
    });

    it('should return null when updating non-existent job', async () => {
      service = new CronService();
      const result = await service.updateJob('nonexistent', { message: 'x' });
      expect(result).toBeNull();
    });

    it('should list only enabled jobs', async () => {
      service = new CronService();
      await service.addJob({ name: 'enabled', schedule: '@hourly', message: 'e', enabled: true });
      await service.addJob({ name: 'disabled', schedule: '@hourly', message: 'd', enabled: false });

      const enabled = service.listEnabledJobs();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('enabled');
    });

    it('should force execute a job', async () => {
      service = new CronService();
      const job = await service.addJob({ name: 'exec-me', schedule: '@hourly', message: 'run it' });

      const result = await service.executeJob(job.id, 'force');
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('should track run logs', async () => {
      service = new CronService();
      const job = await service.addJob({ name: 'logged', schedule: '@hourly', message: 'msg' });

      await service.executeJob(job.id, 'force');

      const logs = service.getRunLogs(job.id);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].jobId).toBe(job.id);
      expect(logs[0].status).toBe('success');
    });

    it('should report status', async () => {
      service = new CronService();
      await service.addJob({ name: 'j1', schedule: '@hourly', message: 'm1' });
      await service.addJob({ name: 'j2', schedule: '@daily', message: 'm2', enabled: false });

      const status = service.getStatus();
      expect(status.jobCount).toBe(2);
      expect(status.enabledJobCount).toBe(1);
    });

    it('should emit events on job lifecycle', async () => {
      service = new CronService();
      const events: string[] = [];

      service.onEvent((e) => events.push(e.type));

      const job = await service.addJob({ name: 'evented', schedule: '@hourly', message: 'msg' });
      await service.updateJob(job.id, { message: 'updated' });
      await service.removeJob(job.id);

      expect(events).toContain('job:added');
      expect(events).toContain('job:updated');
      expect(events).toContain('job:removed');
    });

    it('should unsubscribe event handler', async () => {
      service = new CronService();
      const events: string[] = [];

      const unsub = service.onEvent((e) => events.push(e.type));
      await service.addJob({ name: 'j', schedule: '@hourly', message: 'm' });
      expect(events).toHaveLength(1);

      unsub();
      await service.addJob({ name: 'j2', schedule: '@hourly', message: 'm2' });
      expect(events).toHaveLength(1); // no new events
    });

    it('should start and stop service', async () => {
      service = new CronService();
      await service.addJob({ name: 'scheduled', schedule: '@hourly', message: 'msg' });

      await service.start();
      expect(service.getStatus().running).toBe(true);

      service.stop();
      expect(service.getStatus().running).toBe(false);
    });

    it('should use custom executor when provided', async () => {
      service = new CronService();
      const executed: string[] = [];

      await service.start({
        execute: async (agentId, message) => {
          executed.push(`${agentId}:${message}`);
          return 'custom result';
        },
      });

      const job = await service.addJob({ name: 'custom', schedule: '@hourly', message: 'task' });
      const result = await service.executeJob(job.id, 'force');

      expect(result).toBe('custom result');
      expect(executed).toContain('main:task');

      service.stop();
    });
  });
});
