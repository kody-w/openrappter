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
    it('commits writes on both sides of an await', async () => {
      let callbackDone!: () => void;
      const done = new Promise<void>((resolve) => { callbackDone = resolve; });

      const outcome = storage.transaction(async () => {
        await storage.setConfig('tx-before', 'before');
        await Promise.resolve();
        await storage.setConfig('tx-after', 'after');
        callbackDone();
        return 'committed';
      }).then(
        (value) => ({ value, error: null }),
        (error: Error) => ({ value: null, error }),
      );

      await done;
      expect(await outcome).toEqual({ value: 'committed', error: null });
      expect(await storage.getConfig('tx-before')).toBe('before');
      expect(await storage.getConfig('tx-after')).toBe('after');
    });

    it('does not let unrelated work join a transaction while it awaits', async () => {
      let entered!: () => void;
      const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const transaction = storage.transaction(async () => {
        await storage.setConfig('tx-inside-before', 'before');
        entered();
        await gate;
        await storage.setConfig('tx-inside-after', 'after');
      });
      // The broken adapter rejects immediately; attach before awaiting the gate.
      const observed = transaction.then(
        () => null,
        (error: Error) => error,
      );

      await transactionEntered;
      let outsideError: Error | null = null;
      try {
        await storage.setConfig('tx-outside', 'outside');
      } catch (error) {
        outsideError = error as Error;
      }
      release();

      expect(outsideError?.message).toMatch(/transaction/i);
      expect(await observed).toBeNull();
      expect(await storage.getConfig('tx-outside')).toBeNull();
      expect(await storage.getConfig('tx-inside-after')).toBe('after');
    });

    it('rolls back writes on both sides of an await when the callback fails', async () => {
      await expect(
        storage.transaction(async () => {
          await storage.setConfig('tx-rollback-before', 'before');
          await Promise.resolve();
          await storage.setConfig('tx-rollback-after', 'after');
          throw new Error('rollback requested');
        }),
      ).rejects.toThrow('rollback requested');

      expect(await storage.getConfig('tx-rollback-before')).toBeNull();
      expect(await storage.getConfig('tx-rollback-after')).toBeNull();
    });

    it('blocks an unawaited child task after the transaction completes', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let childFinished!: (error: Error | null) => void;
      const childResult = new Promise<Error | null>((resolve) => {
        childFinished = resolve;
      });

      await storage.transaction(async () => {
        void (async () => {
          await gate;
          try {
            await storage.setConfig('tx-late-child', 'must-not-persist');
            childFinished(null);
          } catch (error) {
            childFinished(error as Error);
          }
        })();
      });

      release();
      expect((await childResult)?.message).toMatch(/transaction completed/i);
      expect(await storage.getConfig('tx-late-child')).toBeNull();
    });

    it('cannot replace or close the connection from inside a transaction', async () => {
      await expect(
        storage.transaction(async () => {
          await storage.setConfig('tx-lifecycle-before', 'before');
          await storage.initialize();
          await storage.setConfig('tx-lifecycle-after', 'after');
        }),
      ).rejects.toThrow(/initialize.*transaction/i);

      expect(await storage.getConfig('tx-lifecycle-before')).toBeNull();
      expect(await storage.getConfig('tx-lifecycle-after')).toBeNull();

      await expect(
        storage.transaction(async () => {
          await storage.close();
        }),
      ).rejects.toThrow(/close.*transaction/i);

      await storage.setConfig('still-open', 'yes');
      expect(await storage.getConfig('still-open')).toBe('yes');
    });

    it('rejects unrelated initialization without corrupting an active transaction', async () => {
      let entered!: () => void;
      const transactionEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });

      const transaction = storage.transaction(async () => {
        await storage.setConfig('tx-owner', 'inside');
        entered();
        await gate;
      });

      await transactionEntered;
      await expect(storage.initialize()).rejects.toThrow(/transaction/i);
      release();
      await transaction;

      expect(await storage.getConfig('tx-owner')).toBe('inside');
      await storage.setConfig('after-owner', 'works');
      expect(await storage.getConfig('after-owner')).toBe('works');
    });

    it('serializes concurrent initialize and close operations', async () => {
      const adapter = createStorageAdapter({ type: 'memory', inMemory: true });

      const initializing = adapter.initialize();
      const closing = adapter.close();
      await Promise.all([initializing, closing]);

      await expect(adapter.getConfig('after-close')).rejects.toThrow(
        /not initialized/i,
      );
    });

    it('does not let a transaction overtake an earlier close', async () => {
      const closing = storage.close();
      const transaction = storage.transaction(async () => {
        await storage.setConfig('after-queued-close', 'must-not-run');
      });

      await closing;
      await expect(transaction).rejects.toThrow(/not initialized/i);

      await storage.initialize();
      expect(await storage.getConfig('after-queued-close')).toBeNull();
    });

    it('can retry cleanly after initialization fails', async () => {
      const adapter = createStorageAdapter({ type: 'memory', inMemory: true });
      const internal = adapter as unknown as {
        runMigrations(db: unknown): Promise<void>;
      };
      const runMigrations = internal.runMigrations.bind(adapter);
      let fail = true;
      internal.runMigrations = async (db: unknown) => {
        if (fail) {
          fail = false;
          throw new Error('injected migration failure');
        }
        await runMigrations(db);
      };

      await expect(adapter.initialize()).rejects.toThrow(
        'injected migration failure',
      );
      await adapter.initialize();
      await adapter.setConfig('after-retry', 'works');
      expect(await adapter.getConfig('after-retry')).toBe('works');
      await adapter.close();
    });

    it('invalidates the connection when rollback itself fails', async () => {
      const internal = storage as unknown as {
        db: {
          exec(sql: string): void;
          close(): void;
          [key: PropertyKey]: unknown;
        } | null;
      };
      const raw = internal.db!;
      internal.db = new Proxy(raw, {
        get(target, property) {
          if (property === 'exec') {
            return (sql: string) => {
              if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await expect(
        storage.transaction(async () => {
          await storage.setConfig('tx-poisoned', 'must-not-survive');
          throw new Error('transaction failed');
        }),
      ).rejects.toThrow(/rollback could not restore/i);

      await expect(storage.getConfig('tx-poisoned')).rejects.toThrow(
        /not initialized/i,
      );

      await storage.initialize();
      await storage.setConfig('after-rollback-retry', 'works');
      expect(await storage.getConfig('after-rollback-retry')).toBe('works');
    });
  });
});
