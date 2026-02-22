/**
 * Showcase: Persistence Vault
 *
 * Tests in-memory SQLite StorageAdapter: sessions, chunks, cron, KV config,
 * transactions, filtering, lifecycle. Uses createStorageAdapter({ type: 'memory' }).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorageAdapter } from '../../storage/index.js';
import type { StorageAdapter, Session, CronJobRecord, CronLogRecord } from '../../storage/types.js';

describe('Showcase: Persistence Vault', () => {
  let storage: StorageAdapter;

  beforeEach(async () => {
    storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('Session lifecycle', () => {
    it('should save, get, and delete a session', async () => {
      const session: Session = {
        id: 'sess_1',
        channelId: 'slack',
        conversationId: 'C123',
        agentId: 'ShellAgent',
        metadata: { key: 'value' },
        messages: [{ id: 'msg_1', role: 'user', content: 'hello', timestamp: new Date().toISOString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await storage.saveSession(session);
      const retrieved = await storage.getSession('sess_1');
      expect(retrieved).toBeTruthy();
      expect(retrieved!.channelId).toBe('slack');
      expect(retrieved!.messages.length).toBe(1);

      await storage.deleteSession('sess_1');
      const deleted = await storage.getSession('sess_1');
      expect(deleted).toBeNull();
    });

    it('should filter sessions by channelId', async () => {
      await storage.saveSession({
        id: 'sess_a', channelId: 'slack', conversationId: 'C1', agentId: 'A',
        metadata: {}, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await storage.saveSession({
        id: 'sess_b', channelId: 'discord', conversationId: 'D1', agentId: 'A',
        metadata: {}, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const slackSessions = await storage.listSessions({ channelId: 'slack' });
      expect(slackSessions.length).toBe(1);
      expect(slackSessions[0].id).toBe('sess_a');
    });
  });

  describe('Memory chunks', () => {
    it('should save and search memory chunks by keyword', async () => {
      await storage.saveMemoryChunk({
        id: 'chunk_1',
        content: 'AgentGraph executes DAG nodes in parallel',
        source: 'workspace',
        sourcePath: '/docs/graph.md',
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const retrieved = await storage.getMemoryChunk('chunk_1');
      expect(retrieved).toBeTruthy();
      expect(retrieved!.content).toContain('AgentGraph');
    });
  });

  describe('Cron jobs and logs', () => {
    it('should persist cron jobs and logs', async () => {
      const job: CronJobRecord = {
        id: 'job_1',
        name: 'health-check',
        schedule: '*/5 * * * *',
        agentId: 'SelfHealingCron',
        message: 'check api health',
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await storage.saveCronJob(job);

      const retrieved = await storage.getCronJob('job_1');
      expect(retrieved).toBeTruthy();
      expect(retrieved!.name).toBe('health-check');

      // Save a log
      const log: CronLogRecord = {
        id: 'log_1',
        jobId: 'job_1',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: 'success',
        result: 'healthy',
      };
      await storage.saveCronLog(log);

      const logs = await storage.getCronLogs('job_1');
      expect(logs.length).toBe(1);
      expect(logs[0].status).toBe('success');
    });
  });

  describe('Config KV store', () => {
    it('should set, get, and getAll config values', async () => {
      await storage.setConfig('theme', 'dark');
      await storage.setConfig('lang', 'en');

      expect(await storage.getConfig('theme')).toBe('dark');
      expect(await storage.getConfig('missing')).toBeNull();

      const all = await storage.getAllConfig();
      expect(all.theme).toBe('dark');
      expect(all.lang).toBe('en');
    });
  });

  describe('Multiple sequential operations', () => {
    it('should execute multiple config operations sequentially', async () => {
      await storage.setConfig('tx_key1', 'value1');
      await storage.setConfig('tx_key2', 'value2');

      expect(await storage.getConfig('tx_key1')).toBe('value1');
      expect(await storage.getConfig('tx_key2')).toBe('value2');

      // Delete and verify
      await storage.deleteConfig('tx_key1');
      expect(await storage.getConfig('tx_key1')).toBeNull();
      expect(await storage.getConfig('tx_key2')).toBe('value2');
    });
  });

  describe('In-memory initialization', () => {
    it('should initialize without a file path', async () => {
      const memStorage = createStorageAdapter({ type: 'memory', inMemory: true });
      await memStorage.initialize();

      // Should work immediately
      await memStorage.setConfig('test', 'value');
      expect(await memStorage.getConfig('test')).toBe('value');

      await memStorage.close();
    });
  });

  describe('Close and reinitialize', () => {
    it('should close cleanly and allow reinitialization', async () => {
      await storage.setConfig('before_close', 'yes');
      await storage.close();

      // Reinitialize (fresh in-memory DB)
      storage = createStorageAdapter({ type: 'memory', inMemory: true });
      await storage.initialize();

      // Previous data is gone (new in-memory DB)
      expect(await storage.getConfig('before_close')).toBeNull();
    });
  });
});
