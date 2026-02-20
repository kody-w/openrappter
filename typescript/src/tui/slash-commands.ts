import type { TuiGatewayClient } from './gateway-client.js';

const SESSION_GREETING_PROMPT = 'A new session was started. Greet the user in your configured persona. Be yourself - use your name, vibe, and mood from your identity. Keep it to 1-3 sentences and ask what they want to do. Do not mention internal steps, files, tools, or reasoning.';

export interface SlashCommand {
  name: string;
  description: string;
  execute: (args: string, client: TuiGatewayClient) => Promise<string | null>;
}

export function parseSlashCommand(input: string): { command: string; args: string } | null {
  if (!input.startsWith('/')) return null;
  const [command, ...rest] = input.slice(1).split(/\s+/);
  return { command: command.toLowerCase(), args: rest.join(' ') };
}

export const commands: SlashCommand[] = [
  { name: 'help', description: 'Show available commands', execute: async () => {
    return commands.map(c => `  /${c.name} — ${c.description}`).join('\n');
  }},
  { name: 'status', description: 'Show gateway status', execute: async (_args, client) => {
    const status = await client.call('status') as Record<string, unknown>;
    return JSON.stringify(status, null, 2);
  }},
  { name: 'agent', description: 'Switch agent', execute: async (args, client) => {
    if (!args) { const agents = await client.call('agents.list') as unknown[]; return JSON.stringify(agents, null, 2); }
    return `Switched to agent: ${args}`;
  }},
  { name: 'session', description: 'Switch session', execute: async (args) => `Session: ${args || 'default'}` },
  { name: 'model', description: 'Switch model', execute: async (args) => `Model: ${args || 'default'}` },
  { name: 'new', description: 'Start a new session', execute: async (_args, client) => {
    try {
      await client.call('chat.send', { message: SESSION_GREETING_PROMPT });
      return null;
    } catch (err) {
      return `Failed: ${(err as Error).message}`;
    }
  }},
  { name: 'reset', description: 'Reset session', execute: async (_args, client) => {
    try {
      await client.call('chat.send', { message: SESSION_GREETING_PROMPT });
      return null;
    } catch (err) {
      return `Failed: ${(err as Error).message}`;
    }
  }},
  { name: 'abort', description: 'Abort current request', execute: async () => 'Aborted' },
  { name: 'channels', description: 'List and configure channels', execute: async (_args, client) => {
    try {
      const channels = await client.call('channels.list') as Array<{
        id: string; type: string; connected: boolean; configured: boolean; running: boolean; messageCount: number;
      }>;
      if (!channels || channels.length === 0) return 'No channels available.';
      const lines = ['Channels:\n'];
      for (const ch of channels) {
        const status = ch.connected ? '✓ connected' : ch.configured ? '○ configured' : '✗ not configured';
        lines.push(`  ${ch.type.padEnd(12)} ${status}  (${ch.messageCount} msgs)`);
      }
      const unconfigured = channels.filter(ch => !ch.configured);
      if (unconfigured.length > 0) {
        lines.push('');
        lines.push(`To configure: /channel-setup <type>  (e.g. /channel-setup telegram)`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Failed to list channels: ${(err as Error).message}`;
    }
  }},
  { name: 'channel-setup', description: 'Configure a channel inline', execute: async (args, client) => {
    const channelType = args.trim().toLowerCase();
    if (!channelType) return 'Usage: /channel-setup <type>  (e.g. /channel-setup telegram)';
    try {
      const fields = await client.call('channels.getConfig', { type: channelType }) as Array<{
        key: string; label: string; type: string; required: boolean;
      }>;
      if (!fields || fields.length === 0) return `No configuration needed for ${channelType}, or channel type not found.`;
      // For now, show the required fields — interactive prompt happens in the TUI input loop
      const lines = [`Configure ${channelType}:\n`];
      for (const f of fields) {
        lines.push(`  ${f.label}${f.required ? ' (required)' : ''}: /channel-set ${channelType} ${f.key} <value>`);
      }
      lines.push('');
      lines.push('Set each value, then run: /channel-connect ' + channelType);
      return lines.join('\n');
    } catch (err) {
      return `Failed to get config for ${channelType}: ${(err as Error).message}`;
    }
  }},
  { name: 'channel-set', description: 'Set a channel config value', execute: async (args, client) => {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 3) return 'Usage: /channel-set <type> <key> <value>';
    const [channelType, key, ...valueParts] = parts;
    const value = valueParts.join(' ');
    try {
      await client.call('channels.configure', { type: channelType, config: { [key]: value } });
      return `Set ${channelType}.${key} — saved.`;
    } catch (err) {
      return `Failed to configure ${channelType}: ${(err as Error).message}`;
    }
  }},
  { name: 'channel-connect', description: 'Connect a configured channel', execute: async (args, client) => {
    const channelType = args.trim().toLowerCase();
    if (!channelType) return 'Usage: /channel-connect <type>';
    try {
      await client.call('channels.connect', { type: channelType });
      return `${channelType} connected successfully!`;
    } catch (err) {
      return `Failed to connect ${channelType}: ${(err as Error).message}`;
    }
  }},
  { name: 'quit', description: 'Exit TUI', execute: async () => null },
];

export async function executeSlashCommand(input: string, client: TuiGatewayClient): Promise<{ result: string | null; isQuit: boolean }> {
  const parsed = parseSlashCommand(input);
  if (!parsed) return { result: null, isQuit: false };
  const cmd = commands.find(c => c.name === parsed.command);
  if (!cmd) return { result: `Unknown command: /${parsed.command}`, isQuit: false };
  const result = await cmd.execute(parsed.args, client);
  return { result, isQuit: parsed.command === 'quit' };
}
