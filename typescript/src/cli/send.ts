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

export function registerSendCommand(program: Command): void {
  program
    .command('send <channel> <message>')
    .description('Send a message to a channel')
    .option('-t, --target <target>', 'Target (room/user ID)')
    .option('-m, --metadata <json>', 'Additional metadata as JSON')
    .action(async (channel: string, message: string, options: { target?: string; metadata?: string }) => {
      await withClient(async (client) => {
        const params: Record<string, unknown> = {
          channel,
          message,
        };
        if (options.target) params.target = options.target;
        if (options.metadata) params.metadata = JSON.parse(options.metadata);

        const result = await client.call('channels.send', params);
        console.log('Message sent:', result);
      });
    });
}
