import type { Command } from 'commander';
import { RpcClient } from './rpc-client.js';

/**
 * Snapshot and restore ~/.openrappter/ from the terminal.
 *
 * The gateway has served `backup.create`, `backup.list`, `backup.restore` and
 * `backup.delete` since the feature landed, and `infra/backup.ts` behind them
 * does real work — it copies files, writes a manifest and can put them back.
 * Nothing shipped ever called any of it. An update could auto-snapshot before
 * it ran, but if that update went wrong the user had no way to reach the
 * snapshot: no CLI command, no menu item, no button. The restore path existed
 * and was unreachable, which is the same as not having one.
 *
 * These commands are a thin wrapper over those four RPC methods, so the
 * terminal and any future UI share one contract.
 */

interface BackupInfo {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  fileCount: number;
}

async function withClient<T>(fn: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = new RpcClient();
  try {
    await client.connect(18790, process.env.OPENRAPPTER_TOKEN);
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(backup: BackupInfo): string {
  const files = backup.fileCount === 1 ? '1 file' : `${backup.fileCount} files`;
  return `${files}, ${formatSize(backup.sizeBytes)}`;
}

export function registerBackupCommand(program: Command): void {
  const backup = program
    .command('backup')
    .description('Snapshot and restore your OpenRappter data');

  backup
    .command('list', { isDefault: true })
    .description('List available backups, most recent first')
    .option('--json', 'Print the raw response')
    .action(async (options: { json?: boolean }) => {
      await withClient(async (client) => {
        const result = (await client.call('backup.list')) as BackupInfo[] | undefined;
        const backups = Array.isArray(result) ? result : [];

        if (options.json) {
          console.log(JSON.stringify(backups, null, 2));
          return;
        }
        if (backups.length === 0) {
          console.log('No backups yet. Create one with:');
          console.log('    openrappter backup create');
          return;
        }
        for (const item of backups) {
          console.log(`\n  ${item.id}`);
          console.log(`    created: ${item.createdAt}`);
          console.log(`    holds:   ${describe(item)}`);
        }
        console.log(`\n  ${backups.length} available. Restore the most recent with:`);
        console.log('    openrappter backup restore --yes');
      });
    });

  backup
    .command('create')
    .description('Create a new backup of ~/.openrappter/')
    .option('--reason <text>', 'Why this backup was taken', 'manual')
    .action(async (options: { reason: string }) => {
      await withClient(async (client) => {
        const result = (await client.call('backup.create', {
          reason: options.reason,
        })) as BackupInfo;
        console.log(`Created ${result.id} (${describe(result)})`);
      });
    });

  backup
    .command('restore [id]')
    .description('Restore from a backup (defaults to the most recent)')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (id: string | undefined, options: { yes?: boolean }) => {
      // restoreBackup copies over the live files in place and takes no
      // snapshot of what it replaces, so there is no undo after this runs.
      if (!options.yes) {
        const which = id ? `backup ${id}` : 'the most recent backup';
        console.log(`WARNING: This overwrites your current OpenRappter data with ${which}.`);
        console.log('Existing files are replaced and are not backed up first.');
        console.log('Run with --yes to confirm.');
        return;
      }
      await withClient(async (client) => {
        const result = (await client.call('backup.restore', id ? { id } : {})) as BackupInfo;
        const files = result.fileCount === 1 ? '1 file' : `${result.fileCount} files`;
        console.log(`Restored ${files} from ${result.id}.`);
        console.log('Restart OpenRappter for the restored data to take effect.');
      });
    });

  backup
    .command('delete <id>')
    .description('Delete a backup')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (id: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        console.log(`WARNING: This permanently deletes backup ${id}.`);
        console.log('Run with --yes to confirm.');
        return;
      }
      await withClient(async (client) => {
        const result = (await client.call('backup.delete', { id })) as { deleted: boolean };
        console.log(result?.deleted ? `Deleted ${id}.` : `No backup matched ${id}.`);
      });
    });
}
