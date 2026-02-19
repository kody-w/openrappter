/**
 * Send Command
 * Send messages from the CLI to one or all connected channels.
 *
 * Usage:
 *   send <channel> <message>          - send to a specific channel
 *   send --all <message>              - broadcast to all connected channels
 *   send --channel telegram --to <chatId> <message>
 *   send <channel> <message> --file <path>   - send with attachment
 */

import type { Command } from 'commander';
import { RpcClient } from './rpc-client.js';
import { promises as fs } from 'fs';

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
    // Command: 'send' — send messages to channels
    .command('send [channel] [message]')
    .description('Send a message to a channel or broadcast to all channels')
    .option('-a, --all', 'Broadcast message to all connected channels')
    .option('-t, --target <target>', 'Target (room/user/chat ID)')
    .option('-m, --metadata <json>', 'Additional metadata as JSON')
    .option('-f, --file <path>', 'Attach a file to the message')
    .option('--channel <channel>', 'Channel name (alternative to positional arg)')
    .option('--to <target>', 'Target ID (alternative to --target)')
    .action(
      async (
        channelArg: string | undefined,
        messageArg: string | undefined,
        options: {
          all?: boolean;
          target?: string;
          metadata?: string;
          file?: string;
          channel?: string;
          to?: string;
        },
      ) => {
        const channel = channelArg ?? options.channel;
        const message = messageArg;
        const target = options.target ?? options.to;

        if (!message && !options.all) {
          console.error('Error: message is required');
          process.exit(1);
        }

        // Handle file attachment
        let attachment: { name: string; data: string; encoding: string } | undefined;
        if (options.file) {
          const data = await fs.readFile(options.file);
          const name = options.file.split('/').pop() ?? 'attachment';
          attachment = {
            name,
            data: data.toString('base64'),
            encoding: 'base64',
          };
        }

        await withClient(async (client) => {
          if (options.all) {
            // Broadcast to all channels
            const params: Record<string, unknown> = { message };
            if (attachment) params.attachment = attachment;
            if (options.metadata) params.metadata = JSON.parse(options.metadata);

            const result = await client.call('channels.broadcast', params);
            console.log('Broadcast sent:', result);
          } else {
            if (!channel) {
              console.error('Error: channel is required when not using --all');
              process.exit(1);
            }

            const params: Record<string, unknown> = { channel, message };
            if (target) params.target = target;
            if (attachment) params.attachment = attachment;
            if (options.metadata) params.metadata = JSON.parse(options.metadata);

            const result = await client.call('channels.send', params);
            console.log('Message sent:', result);
          }
        });
      },
    );
}
