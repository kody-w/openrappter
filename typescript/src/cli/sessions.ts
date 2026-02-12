import type { Command } from 'commander';
import { RpcClient } from './rpc-client.js';

async function withClient<T>(fn: (client: RpcClient) => Promise<T>): Promise<T> {
  const client = new RpcClient();
  try {
    await client.connect(18790, process.env.OPENRAPPTER_TOKEN);
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

export function registerSessionsCommand(program: Command): void {
  const sessions = program.command('sessions').description('Manage chat sessions');

  sessions
    .command('list')
    .description('List all active sessions')
    .action(async () => {
      await withClient(async (client) => {
        const result = await client.call('sessions.list');
        console.log(JSON.stringify(result, null, 2));
      });
    });

  sessions
    .command('show <id>')
    .description('Show session details')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = await client.call('sessions.get', { id });
        console.log(JSON.stringify(result, null, 2));
      });
    });

  sessions
    .command('delete <id>')
    .description('Delete a session')
    .action(async (id: string) => {
      await withClient(async (client) => {
        await client.call('sessions.delete', { id });
        console.log(`Deleted session: ${id}`);
      });
    });

  sessions
    .command('reset <id>')
    .description('Reset session history')
    .action(async (id: string) => {
      await withClient(async (client) => {
        await client.call('sessions.reset', { id });
        console.log(`Reset session: ${id}`);
      });
    });
}
