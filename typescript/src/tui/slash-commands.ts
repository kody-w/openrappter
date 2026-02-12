import type { TuiGatewayClient } from './gateway-client.js';

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
  { name: 'new', description: 'New session', execute: async () => 'New session created' },
  { name: 'reset', description: 'Reset session', execute: async () => 'Session reset' },
  { name: 'abort', description: 'Abort current request', execute: async () => 'Aborted' },
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
