/**
 * Backup RPC methods — snapshot & restore ~/.openrappter/ user data.
 *
 * Methods:
 *   backup.create   — Create a new backup (auto-runs before updates)
 *   backup.list     — List available backups
 *   backup.restore  — Restore from a specific backup (or latest)
 *   backup.delete   — Delete a specific backup
 */

import {
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  type BackupInfo,
} from '../../infra/backup.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

export function registerBackupMethods(
  server: MethodRegistrar,
  _deps?: Record<string, unknown>
): void {
  server.registerMethod<{ reason?: string }, BackupInfo>(
    'backup.create',
    async (params) => {
      return createBackup(params?.reason ?? 'manual');
    }
  );

  server.registerMethod<void, BackupInfo[]>(
    'backup.list',
    async () => {
      return listBackups();
    }
  );

  server.registerMethod<{ id?: string }, BackupInfo>(
    'backup.restore',
    async (params) => {
      return restoreBackup(params?.id);
    }
  );

  server.registerMethod<{ id: string }, { deleted: boolean }>(
    'backup.delete',
    async (params) => {
      return { deleted: deleteBackup(params.id) };
    },
    { requiresAuth: true }
  );
}
