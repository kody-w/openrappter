import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';

import { registerBackupCommand } from '../backup.js';
import { registerBackupMethods } from '../../gateway/methods/backup-methods.js';

/**
 * A backup you cannot restore is not a backup.
 *
 * `infra/backup.ts` copies files, writes a manifest and can put them back, and
 * the gateway has served all four operations since the feature landed. No
 * shipped client called any of them. An update could snapshot before it ran and
 * the user still had no way to reach that snapshot afterwards — no command, no
 * menu item, no button.
 *
 * These assert the wire contract, and that the destructive paths stay behind an
 * explicit confirmation.
 */

const calls: Array<{ method: string; params?: unknown }> = [];

vi.mock('../rpc-client.js', () => ({
  RpcClient: class {
    async connect(): Promise<void> {}
    disconnect(): void {}
    async call(method: string, params?: unknown): Promise<unknown> {
      calls.push({ method, params });
      if (method === 'backup.list') {
        return [{
          id: '2026-02-11T09-00-00',
          path: '/home/u/.openrappter/backups/2026-02-11T09-00-00',
          createdAt: '2026-02-11T09:00:00.000Z',
          sizeBytes: 2048,
          fileCount: 7,
        }];
      }
      if (method === 'backup.delete') return { deleted: true };
      return {
        id: '2026-02-11T09-00-00',
        path: '/home/u/.openrappter/backups/2026-02-11T09-00-00',
        createdAt: '2026-02-11T09:00:00.000Z',
        sizeBytes: 2048,
        fileCount: 7,
      };
    }
  },
}));

async function run(args: string[]): Promise<string[]> {
  calls.length = 0;
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
    lines.push(a.join(' '));
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerBackupCommand(program);
    await program.parseAsync(['node', 'openrappter', 'backup', ...args]);
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('openrappter backup', () => {
  it('lists backups over backup.list', async () => {
    const lines = await run(['list']);
    expect(calls).toEqual([{ method: 'backup.list', params: undefined }]);
    const text = lines.join('\n');
    expect(text).toContain('2026-02-11T09-00-00');
    expect(text).toContain('7 files');
  });

  it('creates over backup.create and passes the reason through', async () => {
    await run(['create', '--reason', 'before upgrade']);
    expect(calls).toEqual([
      { method: 'backup.create', params: { reason: 'before upgrade' } },
    ]);
  });

  it('restores the most recent when no id is given', async () => {
    await run(['restore', '--yes']);
    expect(calls).toEqual([{ method: 'backup.restore', params: {} }]);
  });

  it('restores a specific backup by id', async () => {
    await run(['restore', '2026-02-11T09-00-00', '--yes']);
    expect(calls).toEqual([
      { method: 'backup.restore', params: { id: '2026-02-11T09-00-00' } },
    ]);
  });

  // restoreBackup overwrites the live files in place and keeps no copy of what
  // it replaced. Without --yes it must not reach the gateway at all.
  it('refuses to restore without --yes, and calls nothing', async () => {
    const lines = await run(['restore']);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('WARNING');
  });

  it('refuses to delete without --yes, and calls nothing', async () => {
    const lines = await run(['delete', '2026-02-11T09-00-00']);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toContain('WARNING');
  });

  it('deletes over backup.delete once confirmed', async () => {
    await run(['delete', '2026-02-11T09-00-00', '--yes']);
    expect(calls).toEqual([
      { method: 'backup.delete', params: { id: '2026-02-11T09-00-00' } },
    ]);
  });
});

describe('backup RPC registration', () => {
  function registeredOptions(): Map<string, { requiresAuth?: boolean } | undefined> {
    const seen = new Map<string, { requiresAuth?: boolean } | undefined>();
    registerBackupMethods({
      registerMethod(name: string, _handler: unknown, options?: { requiresAuth?: boolean }) {
        seen.set(name, options);
      },
    } as Parameters<typeof registerBackupMethods>[0]);
    return seen;
  }

  it('serves every operation the CLI depends on', () => {
    const names = [...registeredOptions().keys()].sort();
    expect(names).toEqual([
      'backup.create',
      'backup.delete',
      'backup.list',
      'backup.restore',
    ]);
  });

  // Restore replaces the live data directory with no undo. It is at least as
  // destructive as delete, which has always required auth.
  it('requires auth to restore, not just to delete', () => {
    const options = registeredOptions();
    expect(options.get('backup.restore')?.requiresAuth).toBe(true);
    expect(options.get('backup.delete')?.requiresAuth).toBe(true);
  });
});
