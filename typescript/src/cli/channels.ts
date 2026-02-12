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

export function registerChannelsCommand(program: Command): void {
  const channels = program.command('channels').description('Manage messaging channels');

  channels
    .command('list')
    .description('List all channels')
    .action(async () => {
      await withClient(async (client) => {
        const result = await client.call('channels.list');
        console.log(JSON.stringify(result, null, 2));
      });
    });

  channels
    .command('connect <channel>')
    .description('Connect a channel')
    .option('-c, --config <json>', 'Channel configuration as JSON')
    .action(async (channel: string, options: { config?: string }) => {
      await withClient(async (client) => {
        const config = options.config ? JSON.parse(options.config) : undefined;
        await client.call('channels.connect', { channel, config });
        console.log(`Connected channel: ${channel}`);
      });
    });

  channels
    .command('disconnect <channel>')
    .description('Disconnect a channel')
    .action(async (channel: string) => {
      await withClient(async (client) => {
        await client.call('channels.disconnect', { channel });
        console.log(`Disconnected channel: ${channel}`);
      });
    });
}
