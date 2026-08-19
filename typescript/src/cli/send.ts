/**
 * Send Command
 * Send a message to a connected channel.
 *
 * Usage:
 *   send <channel> <message>
 *   send --channel telegram --to <chatId> <message>
 *   send <channel> <message> --file <path>   - send with attachment
 *
 * ## What was wrong
 *
 * Every field name was wrong. `channels.send` takes a `SendMessageRequest`
 * (`gateway/types.ts:246`) -- `{ channelId, conversationId, content,
 * attachments }` -- and this sent `{ channel, message, target, attachment }`,
 * so all four arrived `undefined` (#206).
 *
 * `--metadata` is removed rather than repaired: `SendMessageRequest` has no
 * such field, so the flag could only ever be accepted and discarded. A flag
 * that reads as configuration and changes nothing is the shape this cleanup
 * keeps finding.
 *
 * ## Why `--all` is refused rather than fixed
 *
 * It called `channels.broadcast`, which **no gateway registers**. That is not
 * a rename: the options are to implement it server-side, drop the flag, or fan
 * out client-side over `channels.list` -- and this command sends real messages
 * to real people, so "message every connected channel" is a decision about
 * blast radius, not a contract fix. Until it is made, the flag says so instead
 * of calling a method that does not exist.
 *
 * The command stays unregistered either way; see
 * `dormant-cli-commands-stay-dormant.test.ts`.
 */

import type { Command } from 'commander';
import path from 'path';
import { withClient } from './with-client.js';
import { promises as fs } from 'fs';

export function registerSendCommand(program: Command): void {
  program
    // Command: 'send' — send messages to channels
    .command('send [channel] [message]')
    .description('Send a message to a channel or broadcast to all channels')
    .option('-a, --all', 'Broadcast message to all connected channels')
    .option('-t, --target <target>', 'Target (room/user/chat ID)')
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
          const name = path.basename(options.file) ?? 'attachment';
          attachment = {
            name,
            data: data.toString('base64'),
            encoding: 'base64',
          };
        }

        await withClient(async (client) => {
          if (options.all) {
            // `channels.broadcast` is not a gateway method. Failing here is
            // the honest outcome: the alternative was a method-not-found stack
            // trace that read like a transport fault rather than a missing
            // feature.
            console.error(
              '\n  --all is not supported: the gateway has no broadcast method.'
              + '\n  Send to one channel at a time: openrappter send <channel> <message>\n',
            );
            process.exitCode = 1;
            return;
          } else {
            if (!channel) {
              console.error('Error: channel is required when not using --all');
              process.exit(1);
            }

            if (!target) {
              console.error(
                '\n  A target is required: channels.send needs a conversation to deliver to.'
                + '\n  Pass one with --to <id> (or --target <id>).\n',
              );
              process.exitCode = 1;
              return;
            }

            // `SendMessageRequest`, spelled exactly as the gateway reads it.
            const params: Record<string, unknown> = {
              channelId: channel,
              conversationId: target,
              content: message,
            };
            if (attachment) params.attachments = [attachment];

            const result = (await client.call('channels.send', params)) as
              | { sent?: boolean }
              | undefined;

            // The gateway answers `{ sent: true }`. Reporting "Message sent"
            // without reading that is how a delivery failure gets recorded as
            // a success (#134).
            if (result?.sent) {
              console.log(`Message sent to ${channel}.`);
            } else {
              console.error(`\n  The gateway did not confirm delivery to ${channel}.\n`);
              process.exitCode = 1;
            }
          }
        });
      },
    );
}
