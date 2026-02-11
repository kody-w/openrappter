/**
 * Telegram channel implementation using Bot API
 */

import { BaseChannel } from './base.js';
import type { OutgoingMessage, IncomingMessage } from './types.js';

export interface TelegramConfig {
  token: string;
  allowedChatIds?: string[];
  webhookUrl?: string;
  pollingInterval?: number;
}

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramChannel extends BaseChannel {
  private config: TelegramConfig;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;

  constructor(config: TelegramConfig) {
    super('telegram', 'telegram');
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    try {
      // Verify token by calling getMe
      const me = await this.callApi('getMe');
      if (!me.ok) throw new Error('Invalid Telegram bot token');

      if (this.config.webhookUrl) {
        await this.callApi('setWebhook', { url: this.config.webhookUrl });
      } else {
        // Clear any existing webhook before polling
        await this.callApi('deleteWebhook');
        this.startPolling();
      }

      this.status = 'connected';
      this.connectedAt = new Date().toISOString();
    } catch (err) {
      this.status = 'error';
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.status = 'disconnected';
  }

  async send(messageOrId: OutgoingMessage | string, message?: OutgoingMessage): Promise<void> {
    const msg = typeof messageOrId === 'string' ? message! : messageOrId;
    const chatId = typeof messageOrId === 'string' ? messageOrId : msg.recipient;

    if (this.status !== 'connected') {
      throw new Error('Telegram channel not connected');
    }

    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: msg.content,
      parse_mode: 'HTML',
    };

    if (msg.replyTo) {
      payload.reply_to_message_id = msg.replyTo;
    }

    await this.callApi('sendMessage', payload);
    this.messageCount++;
  }

  handleWebhookUpdate(update: Record<string, unknown>): void {
    const msg = update.message as Record<string, unknown> | undefined;
    if (!msg) return;

    const chat = msg.chat as Record<string, unknown>;
    const from = msg.from as Record<string, unknown>;

    if (this.config.allowedChatIds?.length) {
      const chatId = String(chat?.id);
      if (!this.config.allowedChatIds.includes(chatId)) return;
    }

    const incoming: IncomingMessage = {
      id: String(msg.message_id),
      channel: 'telegram',
      sender: String(from?.id ?? 'unknown'),
      senderName: String(from?.username ?? from?.first_name ?? 'unknown'),
      content: String(msg.text ?? ''),
      timestamp: new Date((msg.date as number) * 1000).toISOString(),
      conversationId: String(chat?.id),
      metadata: {
        chatId: String(chat?.id),
        chatType: chat?.type,
      },
    };

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
    try {
      const result = await this.callApi('getUpdates', {
        offset: this.offset,
        timeout: 10,
        allowed_updates: ['message'],
      });

      if (result.ok && Array.isArray(result.result)) {
        for (const update of result.result) {
          this.offset = (update.update_id as number) + 1;
          this.handleWebhookUpdate(update);
        }
      }
    } catch {
      // Polling errors are non-fatal
    }
  }

  private async callApi(method: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${TELEGRAM_API}/bot${this.config.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }
}
