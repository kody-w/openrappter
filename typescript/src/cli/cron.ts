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

export function registerCronCommand(program: Command): void {
  const cron = program.command('cron').description('Manage cron jobs');

  cron
    .command('list')
    .description('List all cron jobs')
    .action(async () => {
      await withClient(async (client) => {
        const result = await client.call('cron.list');
        console.log(JSON.stringify(result, null, 2));
      });
    });

  cron
    .command('add <schedule> <action>')
    .description('Add a new cron job')
    .option('-d, --description <desc>', 'Job description')
    .action(async (schedule: string, action: string, options: { description?: string }) => {
      await withClient(async (client) => {
        const result = await client.call('cron.add', {
          schedule,
          action,
          description: options.description,
        });
        console.log('Cron job added:', result);
      });
    });

  cron
    .command('remove <id>')
    .description('Remove a cron job')
    .action(async (id: string) => {
      await withClient(async (client) => {
        await client.call('cron.remove', { id });
        console.log(`Removed cron job: ${id}`);
      });
    });

  cron
    .command('run <id>')
    .description('Run a cron job immediately')
    .action(async (id: string) => {
      await withClient(async (client) => {
        const result = await client.call('cron.run', { id });
        console.log('Job result:', result);
      });
    });

  cron
    .command('enable <id>')
    .description('Enable a cron job')
    .option('--disable', 'Disable instead of enable')
    .action(async (id: string, options: { disable?: boolean }) => {
      await withClient(async (client) => {
        await client.call('cron.enable', { id, enabled: !options.disable });
        console.log(`${options.disable ? 'Disabled' : 'Enabled'} cron job: ${id}`);
      });
    });
}
