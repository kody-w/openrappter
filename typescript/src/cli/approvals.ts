import type { Command } from 'commander';
import { withClient } from './with-client.js';

/**
 * Resolve exec approvals from the terminal.
 *
 * The gateway has served `exec.pending` and `exec.respond` for some time, and
 * until now the only client that called them was the macOS menu bar app. On
 * Linux and Windows a command the safety policy gated could be *requested* and
 * never granted: the agent hands back an approval id and there is nowhere to
 * take it. That gap widened when `git`, environment assignments and plantable
 * paths started requiring approval.
 *
 * These commands are a thin wrapper over the same two RPC methods the Bar
 * uses, so there is one approval contract rather than two.
 */

interface PendingApproval {
  id: string;
  cmd?: string;
  command?: string;
  binary?: string;
  reason?: string;
  kind?: string;
  expiresAt?: string;
}

export function registerApprovalsCommand(program: Command): void {
  const approvals = program
    .command('approvals')
    .description('Review commands waiting on your approval');

  approvals
    .command('list', { isDefault: true })
    .description('Show commands waiting for approval')
    .option('--json', 'Print the raw response')
    .action(async (options: { json?: boolean }) => {
      await withClient(async (client) => {
        const result = await client.call('exec.pending') as PendingApproval[] | undefined;
        const pending = Array.isArray(result) ? result : [];

        if (options.json) {
          console.log(JSON.stringify(pending, null, 2));
          return;
        }
        if (pending.length === 0) {
          console.log('Nothing is waiting for approval.');
          return;
        }
        for (const item of pending) {
          const command = item.cmd ?? item.command ?? '(unknown command)';
          console.log(`\n  ${item.id}`);
          console.log(`    command: ${command}`);
          // The reason is the point of showing this at all: `LD_PRELOAD=… ls`
          // reads as an ordinary `ls` until something says otherwise.
          if (item.reason) console.log(`    why:     ${item.reason}`);
          if (item.expiresAt) console.log(`    expires: ${item.expiresAt}`);
        }
        console.log(`\n  ${pending.length} waiting. Approve with:`);
        console.log(`    openrappter approvals approve ${pending[0].id}`);
      });
    });

  approvals
    .command('approve <id>')
    .description('Approve a waiting command')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = await client.call('exec.respond', { approvalId: id, approved: true });
        console.log(JSON.stringify(result, null, 2));
      });
    });

  approvals
    .command('deny <id>')
    .description('Deny a waiting command')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = await client.call('exec.respond', { approvalId: id, approved: false });
        console.log(JSON.stringify(result, null, 2));
      });
    });
}
