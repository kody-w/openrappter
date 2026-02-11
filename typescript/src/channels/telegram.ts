/**
 * Telegram channel implementation
 */

import { BaseChannel } from './base.js';
import type { OutgoingMessage, IncomingMessage } from './types.js';

export interface TelegramConfig {
  token: string;
  allowedChatIds?: string[];
  webhookUrl?: string;
  pollingInterval?: number;
}

export class TelegramChannel extends BaseChannel {
  private config: TelegramConfig;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: TelegramConfig) {
    super('telegram', 'telegram');
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    try {
      if (this.config.webhookUrl) {
        // Webhook mode - register webhook URL with Telegram
        this.status = 'connected';
        this.connectedAt = new Date().toISOString();
      } else {
        // Polling mode
        this.startPolling();
        this.status = 'connected';
        this.connectedAt = new Date().toISOString();
      }
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.status = 'disconnected';
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error('Telegram channel not connected');
    }

    // In production, this would call the Telegram Bot API
    // POST https://api.telegram.org/bot{token}/sendMessage
    const _payload = {
      chat_id: message.recipient,
      text: message.content,
      reply_to_message_id: message.replyTo,
    };

    this.messageCount++;
  }

  handleWebhookUpdate(update: Record<string, unknown>): void {
    const msg = update.message as Record<string, unknown> | undefined;
    if (!msg) return;

    const chat = msg.chat as Record<string, unknown>;
    const from = msg.from as Record<string, unknown>;

    const incoming: IncomingMessage = {
      id: String(msg.message_id),
      channel: 'telegram',
      sender: String(from?.username ?? from?.id ?? 'unknown'),
      content: String(msg.text ?? ''),
      timestamp: new Date((msg.date as number) * 1000).toISOString(),
      metadata: {
        chatId: String(chat?.id),
        chatType: chat?.type,
      },
    };

    if (this.config.allowedChatIds?.length) {
      const chatId = String(chat?.id);
      if (!this.config.allowedChatIds.includes(chatId)) {
        return;
      }
    }

    this.emitMessage(incoming);
  }

  private startPolling(): void {
    const interval = this.config.pollingInterval ?? 1000;
    this.pollingTimer = setInterval(() => {
      this.pollUpdates().catch(() => {});
    }, interval);
  }

  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private async pollUpdates(): Promise<void> {
    // In production, this would call getUpdates from Telegram Bot API
  }
}
