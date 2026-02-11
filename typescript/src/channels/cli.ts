/**
 * CLI Channel - Interactive terminal interface
 */

import readline from 'readline';
import { randomUUID } from 'crypto';
import { BaseChannel } from './base.js';
import type { OutgoingMessage, IncomingMessage, Conversation } from './types.js';

const CLI_USER_ID = 'cli-user';
const CLI_CONVERSATION_ID = 'cli-main';

export class CLIChannel extends BaseChannel {
  id = 'cli';
  name = 'CLI';

  private rl: readline.Interface | null = null;
  private prompt: string;

  constructor(prompt = '> ') {
    super();
    this.prompt = prompt;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.connected = true;
    this.startReadLoop();
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    this.rl?.close();
    this.rl = null;
    this.connected = false;
  }

  async send(_conversationId: string, message: OutgoingMessage): Promise<void> {
    console.log(`\n${message.content}\n`);
  }

  async getConversations(): Promise<Conversation[]> {
    return [
      {
        id: CLI_CONVERSATION_ID,
        name: 'CLI Session',
        type: 'dm',
      },
    ];
  }

  private startReadLoop(): void {
    if (!this.rl) return;

    const askQuestion = (): void => {
      this.rl?.question(this.prompt, async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          askQuestion();
          return;
        }

        // Handle quit commands
        if (['quit', 'exit', 'q'].includes(trimmed.toLowerCase())) {
          await this.disconnect();
          process.exit(0);
          return;
        }

        // Create incoming message
        const message: IncomingMessage = {
          id: `msg_${randomUUID().slice(0, 8)}`,
          channel: this.id,
          conversationId: CLI_CONVERSATION_ID,
          senderId: CLI_USER_ID,
          senderName: 'User',
          content: trimmed,
          timestamp: new Date().toISOString(),
        };

        // Emit to handlers
        await this.emitMessage(message);

        // Continue reading
        askQuestion();
      });
    };

    askQuestion();
  }
}

export function createCLIChannel(prompt?: string): CLIChannel {
  return new CLIChannel(prompt);
}
