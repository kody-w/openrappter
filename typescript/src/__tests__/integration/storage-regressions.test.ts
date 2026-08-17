/**
 * SQLite storage correctness regressions.
 *
 * Each test here corresponds to a bug that was reproduced against a real
 * on-disk SQLite database before the fix was written:
 *
 *  1. transaction() accepted async callbacks. better-sqlite3 rejects them, but
 *     the callback body kept running and its writes landed *after* the
 *     transaction had already been rolled back.
 *  2. Migration DDL and the migrations version row were written separately, so a
 *     migration that failed partway left the schema half-applied with no version
 *     marker — every subsequent startup replayed it and failed forever.
 *  3. Parent rows were written with INSERT OR REPLACE. In SQLite that is a
 *     DELETE + INSERT, which fires child foreign key actions (ON DELETE SET NULL
 *     / ON DELETE CASCADE) and silently destroys associated rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '../../storage/sqlite.js';
import { migrations, type Migration } from '../../storage/migrations.js';
import type { Session, Device } from '../../storage/types.js';

interface RawDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
}

/** Reach the underlying better-sqlite3 handle to assert on raw rows. */
function raw(adapter: SQLiteAdapter): RawDb {
  return (adapter as unknown as { db: RawDb }).db;
}

const NOW = '2024-01-01T00:00:00.000Z';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    channelId: 'cli',
    conversationId: 'conv-1',
    agentId: 'main',
    metadata: {},
    messages: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDevice(id: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    name: 'laptop',
    type: 'cli',
    lastSeen: NOW,
    trusted: true,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('SQLiteAdapter regressions', () => {
  let dir: string;
  let adapter: SQLiteAdapter | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openrappter-storage-'));
    adapter = null;
  });

  afterEach(async () => {
    if (adapter) await adapter.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(file = 'test.db'): Promise<SQLiteAdapter> {
    const a = new SQLiteAdapter({ type: 'sqlite', path: join(dir, file) });
    await a.initialize();
    adapter = a;
    return a;
  }

  // ── 1. Async transaction callbacks ────────────────────────────────────

  describe('transaction()', () => {
    it('rejects an async callback without running any of its body', async () => {
      const a = await open();
      let ran = false;

      const asyncFn = async () => {
        ran = true;
        await a.setConfig('leaked', 'yes');
        return 1;
      };

      await expect(
        // The type system rejects this too; the cast proves the runtime guard.
        a.transaction(asyncFn as unknown as () => number)
      ).rejects.toThrow(/synchronous callback/i);

      expect(ran).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(await a.getConfig('leaked')).toBeNull();
    });

    it('rejects a promise-returning callback and rolls back its synchronous writes', async () => {
      const a = await open();

      const promiseFn = () => {
        void a.setConfig('sync-write', 'written');
        return Promise.resolve('later');
      };

      await expect(a.transaction(promiseFn as unknown as () => string)).rejects.toThrow(
        /synchronous callback/i
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(await a.getConfig('sync-write')).toBeNull();
    });

    it('commits a synchronous callback and returns its value', async () => {
      const a = await open();

      const result = await a.transaction(() => {
        void a.setConfig('committed-a', '1');
        void a.setConfig('committed-b', '2');
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(await a.getConfig('committed-a')).toBe('1');
      expect(await a.getConfig('committed-b')).toBe('2');
    });

    it('rolls back every write when a synchronous callback throws', async () => {
      const a = await open();
      await a.setConfig('pre-existing', 'kept');

      await expect(
        a.transaction((): void => {
          void a.setConfig('rolled-back-a', '1');
          void a.setConfig('rolled-back-b', '2');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(await a.getConfig('rolled-back-a')).toBeNull();
      expect(await a.getConfig('rolled-back-b')).toBeNull();
      expect(await a.getConfig('pre-existing')).toBe('kept');
    });
  });

  // ── 2. Migration atomicity ────────────────────────────────────────────

  describe('migrations', () => {
    /** Adapter whose migration set can be swapped, to induce a mid-migration failure. */
    class InjectableAdapter extends SQLiteAdapter {
      constructor(
        path: string,
        private readonly set: Migration[]
      ) {
        super({ type: 'sqlite', path });
      }
      protected override getMigrations(): Migration[] {
        return this.set;
      }
    }

    /** migration 3 (add_session_tokens) with a syntax error after the first ALTER */
    const brokenThird: Migration = {
      id: 3,
      name: 'add_session_tokens',
      up: `
        ALTER TABLE sessions ADD COLUMN total_tokens INTEGER DEFAULT 0;
        ALTER TABLE sessions ADD COLUMN prompt_tokens INTEGER DEFAULT 0 THIS IS NOT SQL;
      `,
      down: '',
    };

    it('rolls back DDL and the version marker together when a migration fails', async () => {
      const path = join(dir, 'mig.db');
      const broken = new InjectableAdapter(path, [...migrations.slice(0, 2), brokenThird]);

      await expect(broken.initialize()).rejects.toThrow(
        /Migration 3 \(add_session_tokens\) failed and was rolled back/
      );

      // The connection stays usable; inspect what actually landed.
      const db = raw(broken);
      const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (c) => c.name
      );
      expect(cols).not.toContain('total_tokens');

      const applied = (db.prepare('SELECT id FROM migrations').all() as { id: number }[]).map(
        (m) => m.id
      );
      expect(applied).toEqual([1, 2]);
      await broken.close();
    });

    it('comes up clean on the next startup after a failed migration', async () => {
      const path = join(dir, 'mig.db');
      const broken = new InjectableAdapter(path, [...migrations.slice(0, 2), brokenThird]);
      await expect(broken.initialize()).rejects.toThrow();
      await broken.close();

      // Restart with the real, correct migration set — must succeed and be complete.
      const a = new SQLiteAdapter({ type: 'sqlite', path });
      adapter = a;
      await expect(a.initialize()).resolves.toBeUndefined();

      const applied = (raw(a).prepare('SELECT id FROM migrations').all() as { id: number }[]).map(
        (m) => m.id
      );
      expect(applied).toEqual(migrations.map((m) => m.id));

      const cols = (raw(a).prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(
        (c) => c.name
      );
      expect(cols).toContain('total_tokens');
      expect(cols).toContain('prompt_tokens');
      expect(cols).toContain('completion_tokens');

      await a.saveSession(makeSession('after-recovery'));
      expect(await a.getSession('after-recovery')).not.toBeNull();
    });
  });

  // ── 3. Parent upserts must not destroy children ───────────────────────

  describe('parent row upserts', () => {
    async function seedApproval(a: SQLiteAdapter): Promise<void> {
      await a.saveSession(makeSession('sess-1'));
      await a.saveDevice(makeDevice('dev-1'));
      raw(a)
        .prepare(
          `INSERT INTO approval_requests
             (id, session_id, device_id, tool_name, tool_args, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('appr-1', 'sess-1', 'dev-1', 'bash', '{}', 'pending', NOW);
    }

    function approval(a: SQLiteAdapter): { session_id: string | null; device_id: string | null } {
      return raw(a).prepare('SELECT * FROM approval_requests WHERE id = ?').get('appr-1') as {
        session_id: string | null;
        device_id: string | null;
      };
    }

    it('keeps the approval association when a session is re-saved', async () => {
      const a = await open();
      await seedApproval(a);
      expect(approval(a).session_id).toBe('sess-1');

      await a.saveSession(makeSession('sess-1', { metadata: { touched: true }, updatedAt: 'later' }));

      expect(approval(a).session_id).toBe('sess-1');
      expect(approval(a).device_id).toBe('dev-1');

      const reloaded = await a.getSession('sess-1');
      expect(reloaded?.metadata).toEqual({ touched: true });
      expect(reloaded?.updatedAt).toBe('later');
    });

    it('keeps the approval association when a device is re-saved', async () => {
      const a = await open();
      await seedApproval(a);
      expect(approval(a).device_id).toBe('dev-1');

      await a.saveDevice(makeDevice('dev-1', { name: 'renamed', trusted: false }));

      expect(approval(a).device_id).toBe('dev-1');
      expect(approval(a).session_id).toBe('sess-1');

      const reloaded = await a.getDevice('dev-1');
      expect(reloaded?.name).toBe('renamed');
      expect(reloaded?.trusted).toBe(false);
    });

    it('keeps cron run history when a cron job is re-saved', async () => {
      const a = await open();
      await a.saveCronJob({
        id: 'job-1',
        name: 'nightly',
        schedule: '0 0 * * *',
        agentId: 'main',
        message: 'run',
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await a.saveCronLog({ id: 'log-1', jobId: 'job-1', startedAt: NOW, status: 'success' });
      expect(await a.getCronLogs('job-1')).toHaveLength(1);

      await a.saveCronJob({
        id: 'job-1',
        name: 'nightly-renamed',
        schedule: '0 0 * * *',
        agentId: 'main',
        message: 'run',
        enabled: false,
        createdAt: NOW,
        updatedAt: 'later',
      });

      expect(await a.getCronLogs('job-1')).toHaveLength(1);
      const job = await a.getCronJob('job-1');
      expect(job?.name).toBe('nightly-renamed');
      expect(job?.enabled).toBe(false);
    });
  });
});
