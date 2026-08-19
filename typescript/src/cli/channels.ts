/**
 * Inspect and control messaging channels from the terminal.
 *
 * Two defects, both of the "reads as working, does nothing" kind (#206):
 *
 *   - `connect` and `disconnect` sent `{ channel }`, but the gateway reads
 *     `params.type`. Both therefore passed `undefined` to the registry.
 *   - `connect --config` was a **silent no-op**. `channels.connect` takes only
 *     `{ type }` and ignores everything else; configuration is a separate
 *     `channels.configure` call. A user could pass a channel's credentials on
 *     the command line, see "Connected channel: slack", and have configured
 *     nothing at all.
 *
 * `--config` now performs the `channels.configure` call it always implied, and
 * only then connects -- so the order matches what the flag says. `configure`
 * is also exposed on its own, because changing a channel's settings without
 * reconnecting it is a reasonable thing to want.
 *
 * `probe` and `config` surface two gateway methods no shipped client called.
 *
 * `connect`, `disconnect` and `configure` require auth; `withClient` forwards
 * `OPENRAPPTER_TOKEN`.
 */
import type { Command } from 'commander';
import { withClient } from './with-client.js';
import { redactSecrets } from '../security/redact.js';

interface ChannelStatus {
  id: string;
  type: string;
  connected: boolean;
  configured: boolean;
  running: boolean;
  messageCount: number;
}

/** Parse a --config payload, failing loudly rather than sending garbage. */
function parseConfig(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`\n  --config is not valid JSON: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error('\n  --config must be a JSON object, e.g. \'{"token":"..."}\'\n');
    process.exitCode = 1;
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

export function registerChannelsCommand(program: Command): void {
  const channels = program.command('channels').description('Inspect and control messaging channels');

  channels
    .command('list', { isDefault: true })
    .description('Show every channel and whether it is connected')
    .option('--json', 'Print the raw response')
    .action(async (options: { json?: boolean }) => {
      await withClient(async (client) => {
        const result = (await client.call('channels.list')) as ChannelStatus[] | undefined;
        const list = Array.isArray(result) ? result : [];

        if (options.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        if (list.length === 0) {
          console.log('No channels are registered.');
          return;
        }
        for (const channel of list) {
          const state = channel.connected ? 'connected' : channel.configured ? 'configured' : 'unconfigured';
          console.log(`\n  ${channel.type}`);
          console.log(`    state:    ${state}`);
          console.log(`    messages: ${channel.messageCount}`);
        }
        console.log(`\n  ${list.length} channel${list.length === 1 ? '' : 's'}.`);
      });
    });

  channels
    .command('connect <type>')
    .description('Connect a channel, optionally configuring it first')
    .option('-c, --config <json>', 'Configuration to apply before connecting')
    .action(async (type: string, options: { config?: string }) => {
      await withClient(async (client) => {
        if (options.config) {
          const config = parseConfig(options.config);
          if (!config) return;
          // channels.connect ignores anything but `type`, so this has to be a
          // separate call. Sending it alongside the connect -- as this command
          // used to -- silently discarded it.
          await client.call('channels.configure', { type, config });
          console.log(`Configured ${type}.`);
        }
        await client.call('channels.connect', { type });
        console.log(`Connected channel: ${type}`);
      });
    });

  channels
    .command('disconnect <type>')
    .description('Disconnect a channel')
    .action(async (type: string) => {
      await withClient(async (client) => {
        await client.call('channels.disconnect', { type });
        console.log(`Disconnected channel: ${type}`);
      });
    });

  channels
    .command('configure <type>')
    .description('Set a channel configuration without connecting')
    .requiredOption('-c, --config <json>', 'Configuration as a JSON object')
    .action(async (type: string, options: { config: string }) => {
      await withClient(async (client) => {
        const config = parseConfig(options.config);
        if (!config) return;
        await client.call('channels.configure', { type, config });
        console.log(`Configured ${type}.`);
      });
    });

  channels
    .command('probe <type>')
    .description('Check whether a channel can reach its service')
    .action(async (type: string) => {
      await withClient(async (client) => {
        const result = await client.call('channels.probe', { type });
        console.log(JSON.stringify(result, null, 2));
      });
    });

  channels
    .command('config <type>')
    .description('Show a channel configuration')
    .action(async (type: string) => {
      await withClient(async (client) => {
        const result = await client.call('channels.getConfig', { type });
        // A channel config holds the channel's token. #178 removed even a
        // 20-character token *prefix* from `login` output because scrollback
        // and CI logs keep it, so printing the whole value here would undo
        // that. redactSecrets is the same one `config show` uses -- "a
        // redactor that some writers bypass is not a redactor".
        console.log(JSON.stringify(redactSecrets(result), null, 2));
      });
    });
}
