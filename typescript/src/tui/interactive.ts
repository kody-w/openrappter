/**
 * Standalone interactive chat using Assistant directly.
 * No gateway, no WebSocket, no blessed — just readline + streaming.
 */

import chalk from 'chalk';
import readline from 'readline';
import type { Assistant } from '../agents/Assistant.js';

export interface InteractiveChatOptions {
  assistant: Assistant;
  emoji?: string;
  name?: string;
  version?: string;
}

export function handleCommand(
  input: string,
  assistant: Assistant,
  conversationKey: string,
): string | 'quit' | null {
  const cmd = input.slice(1).split(/\s+/)[0].toLowerCase();
  switch (cmd) {
    case 'quit':
    case 'exit':
    case 'q':
      return 'quit';
    case 'help':
      return '  /help  — this\n  /new   — new conversation\n  /quit  — exit';
    case 'new':
    case 'reset':
      assistant.clearConversation(conversationKey);
      return chalk.yellow('New conversation started.');
    default:
      return chalk.yellow(`Unknown command: /${cmd}`);
  }
}

export async function startInteractiveChat(opts: InteractiveChatOptions): Promise<void> {
  const { assistant, emoji = '🦖', name = 'openrappter', version = '' } = opts;
  const conversationKey = `interactive_${Date.now()}`;

  const header = `${emoji} ${name}${version ? ` v${version}` : ''} ${chalk.dim('• /help • /quit')}`;
  console.log(`\n${header}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = (): void => {
    rl.question(chalk.cyan('You: '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.startsWith('/')) {
        const result = handleCommand(trimmed, assistant, conversationKey);
        if (result === 'quit') {
          console.log(`\nGoodbye! ${emoji}\n`);
          rl.close();
          return;
        }
        if (result) console.log(result);
        prompt();
        return;
      }

      process.stdout.write(chalk.green(`\n${emoji}: `));
      try {
        const result = await assistant.getResponseStreaming(
          trimmed,
          (delta) => process.stdout.write(delta),
          conversationKey,
        );
        process.stdout.write('\n\n');
        for (const log of result.agentLogs) {
          console.log(chalk.dim(`  ${log}`));
        }
      } catch (err) {
        process.stdout.write('\n');
        console.log(chalk.red(`Error: ${(err as Error).message}`));
        console.log('');
      }
      prompt();
    });
  };
  prompt();
}
