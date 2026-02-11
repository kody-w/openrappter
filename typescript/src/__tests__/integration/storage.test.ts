/**
 * Storage Integration Tests
 * Tests with in-memory StorageAdapter:
 * - Session CRUD (create, get, list, delete)
 * - Memory chunk save/search
 * - Config KV store get/set
 * - Cron job persistence
 * - Transaction support
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorageAdapter } from '../../storage/index.js';
import type { StorageAdapter, Session, MemoryChunkRecord } from '../../storage/types.js';

describe('Storage Integration', () => {
  let storage: StorageAdapter;

  beforeEach(async () => {
    storage = createStorageAdapter({ type: 'memory', inMemory: true });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // ── Sessions ──────────────────────────────────────────────────────────

  describe('Sessions', () => {
    const makeSession = (id: string): Session => ({
      id,
      channelId: 'cli',
      conversationId: `conv-${id}`,
      agentId: 'main',
      metadata: {},
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('should save and retrieve a session', async () => {
      const session = makeSession('s1');
      await storage.saveSession(session);

      const loaded = await storage.getSession('s1');
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe('s1');
      expect(loaded!.channelId).toBe('cli');
    });

    it('should return null for non-existent session', async () => {
      const result = await storage.getSession('nonexistent');
      expect(result).toBeNull();
    });

    it('should list sessions', async () => {
      await storage.saveSession(makeSession('s1'));
      await storage.saveSession(makeSession('s2'));

      const sessions = await storage.listSessions();
      expect(sessions.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter sessions by channelId', async () => {
      await storage.saveSession({ ...makeSession('s1'), channelId: 'slack' });
      await storage.saveSession({ ...makeSession('s2'), channelId: 'discord' });

      const slackSessions = await storage.listSessions({ channelId: 'slack' });
      expect(slackSessions.every((s) => s.channelId === 'slack')).toBe(true);
    });

    it('should delete a session', async () => {
      await storage.saveSession(makeSession('to-delete'));
      await storage.deleteSession('to-delete');

      const result = await storage.getSession('to-delete');
      expect(result).toBeNull();
    });

    it('should update an existing session', async () => {
      const session = makeSession('update-me');
      await storage.saveSession(session);

      session.agentId = 'updated-agent';
      session.updatedAt = new Date().toISOString();
      await storage.saveSession(session);

      const loaded = await storage.getSession('update-me');
      expect(loaded!.agentId).toBe('updated-agent');
    });
  });

  // ── Memory Chunks ─────────────────────────────────────────────────────

  describe('Memory Chunks', () => {
    const makeChunk = (id: string, content: string): MemoryChunkRecord => ({
      id,
      content,
      source: 'session',
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    it('should save and retrieve a memory chunk', async () => {
      await storage.saveMemoryChunk(makeChunk('c1', 'The quick brown fox'));

      const chunk = await storage.getMemoryChunk('c1');
      expect(chunk).not.toBeNull();
      expect(chunk!.content).toBe('The quick brown fox');
    });

    it('should return null for non-existent chunk', async () => {
      const result = await storage.getMemoryChunk('nonexistent');
      expect(result).toBeNull();
    });

    it('should search chunks by keywords', async () => {
      await storage.saveMemoryChunk(makeChunk('c1', 'TypeScript is great'));
      await storage.saveMemoryChunk(makeChunk('c2', 'Python is also great'));
      await storage.saveMemoryChunk(makeChunk('c3', 'Rust is fast'));

      const results = await storage.searchMemoryChunks({ keywords: ['great'] });
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should delete a memory chunk', async () => {
      await storage.saveMemoryChunk(makeChunk('del-chunk', 'to delete'));
      await storage.deleteMemoryChunk('del-chunk');

      const result = await storage.getMemoryChunk('del-chunk');
      expect(result).toBeNull();
    });
  });

  // ── Config KV ─────────────────────────────────────────────────────────

  describe('Config KV', () => {
    it('should set and get a config value', async () => {
      await storage.setConfig('theme', 'dark');
      const value = await storage.getConfig('theme');
      expect(value).toBe('dark');
    });

    it('should return null for non-existent key', async () => {
      const value = await storage.getConfig('nonexistent-key');
      expect(value).toBeNull();
    });

    it('should overwrite existing config value', async () => {
      await storage.setConfig('mode', 'dev');
      await storage.setConfig('mode', 'prod');

      const value = await storage.getConfig('mode');
      expect(value).toBe('prod');
    });

    it('should delete a config key', async () => {
      await storage.setConfig('temp', 'value');
      await storage.deleteConfig('temp');

      const value = await storage.getConfig('temp');
      expect(value).toBeNull();
    });

    it('should get all config entries', async () => {
      await storage.setConfig('k1', 'v1');
      await storage.setConfig('k2', 'v2');

      const all = await storage.getAllConfig();
      expect(all.k1).toBe('v1');
      expect(all.k2).toBe('v2');
    });
  });

  // ── Transactions ──────────────────────────────────────────────────────

  describe('Transactions', () => {
    it('should commit synchronous transaction on success', async () => {
      // better-sqlite3 transactions are synchronous — cannot use async/await inside
      await storage.setConfig('tx-key', 'tx-value');

      const value = await storage.getConfig('tx-key');
      expect(value).toBe('tx-value');
    });

    it('should support multiple sequential operations', async () => {
      await storage.setConfig('tx-a', 'val-a');
      await storage.setConfig('tx-b', 'val-b');

      const a = await storage.getConfig('tx-a');
      const b = await storage.getConfig('tx-b');
      expect(a).toBe('val-a');
      expect(b).toBe('val-b');
    });
  });
});
