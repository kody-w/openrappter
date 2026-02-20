/**
 * Telegram channel implementation using Bot API
 * Supports MarkdownV2 formatting, typing indicators, photo/document sending,
 * long message splitting, and command handling.
 */

import { BaseChannel } from './base.js';
import type { OutgoingMessage, IncomingMessage, Attachment } from './types.js';

export interface TelegramConfig {
  token: string;
  allowedChatIds?: string[];
  webhookUrl?: string;
  pollingInterval?: number;
}

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramChannel extends BaseChannel {
  private config: TelegramConfig;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;
  private botInfo: { id: number; username: string } | null = null;

  constructor(config: TelegramConfig) {
    super('telegram', 'telegram');
    this.config = config;
  }

  override getConfigFields() {
    return [
      { key: 'token', label: 'Bot Token', type: 'password' as const, required: true },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text' as const, required: false },
      { key: 'pollingInterval', label: 'Polling Interval (ms)', type: 'text' as const, required: false },
    ];
  }

  async connect(): Promise<void> {
    if (!this.config.token || !this.config.token.match(/^\d+:.+$/)) {
      this.status = 'error';
      throw new Error('Telegram bot token not configured. Go to Channels → Telegram → Configure to set it.');
    }

    this.status = 'connecting';

    try {
      const me = await this.callApi('getMe');
      if (!me.ok) throw new Error('Invalid Telegram bot token');

      const result = me.result as Record<string, unknown>;
      this.botInfo = {
        id: result.id as number,
        username: result.username as string,
      };

      // Set bot commands menu
      await this.callApi('setMyCommands', {
        commands: [
          { command: 'start', description: 'Start chatting with OpenRappter' },
          { command: 'help', description: 'Show available capabilities' },
          { command: 'status', description: 'Check bot status' },
          { command: 'clear', description: 'Clear conversation context' },
        ],
      });

      if (this.config.webhookUrl) {
        await this.callApi('setWebhook', { url: this.config.webhookUrl });
      } else {
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

    // Send typing indicator
    await this.callApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

    // Handle attachments first
    if (msg.attachments?.length) {
      for (const att of msg.attachments) {
        await this.sendAttachment(chatId!, att, msg.replyTo);
      }
    }

    // Send text content (split if needed)
    if (msg.content) {
      const formatted = markdownToTelegram(msg.content);
      const chunks = splitMessage(formatted, MAX_MESSAGE_LENGTH);

      for (let i = 0; i < chunks.length; i++) {
        const payload: Record<string, unknown> = {
          chat_id: chatId,
          text: chunks[i],
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        };

        // Reply-to only on first chunk
        if (i === 0 && msg.replyTo) {
          payload.reply_to_message_id = msg.replyTo;
        }

        try {
          await this.callApi('sendMessage', payload);
        } catch {
          // Fallback to plain text if MarkdownV2 parsing fails
          payload.text = msg.content.slice(
            i * MAX_MESSAGE_LENGTH,
            (i + 1) * MAX_MESSAGE_LENGTH,
          ) || chunks[i];
          delete payload.parse_mode;
          await this.callApi('sendMessage', payload);
        }
      }
    }

    this.messageCount++;
  }

  private async sendAttachment(chatId: string, att: Attachment, replyTo?: string): Promise<void> {
    const base: Record<string, unknown> = { chat_id: chatId };
    if (replyTo) base.reply_to_message_id = replyTo;

    if (att.type === 'image' && att.url) {
      await this.callApi('sendPhoto', { ...base, photo: att.url, caption: att.filename });
    } else if (att.type === 'audio' && att.url) {
      await this.callApi('sendAudio', { ...base, audio: att.url, title: att.filename });
    } else if (att.type === 'video' && att.url) {
      await this.callApi('sendVideo', { ...base, video: att.url, caption: att.filename });
    } else if (att.url) {
      await this.callApi('sendDocument', { ...base, document: att.url, caption: att.filename });
    }
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

    // Extract text from various message types
    const text = String(
      msg.text ?? msg.caption ?? '',
    );

    // Build attachments from Telegram media
    const attachments: Attachment[] = [];
    if (msg.photo) {
      const photos = msg.photo as Array<Record<string, unknown>>;
      const largest = photos[photos.length - 1];
      attachments.push({
        type: 'image',
        url: String(largest?.file_id ?? ''),
        filename: 'photo.jpg',
      });
    }
    if (msg.document) {
      const doc = msg.document as Record<string, unknown>;
      attachments.push({
        type: 'document',
        url: String(doc.file_id ?? ''),
        filename: String(doc.file_name ?? 'document'),
        mimeType: String(doc.mime_type ?? ''),
      });
    }
    if (msg.voice) {
      const voice = msg.voice as Record<string, unknown>;
      attachments.push({
        type: 'audio',
        url: String(voice.file_id ?? ''),
        filename: 'voice.ogg',
      });
    }
    if (msg.sticker) {
      const sticker = msg.sticker as Record<string, unknown>;
      attachments.push({
        type: 'image',
        url: String(sticker.file_id ?? ''),
        filename: String(sticker.emoji ?? '🦖') + '.webp',
      });
    }

    const incoming: IncomingMessage = {
      id: String(msg.message_id),
      channel: 'telegram',
      sender: String(from?.id ?? 'unknown'),
      senderName: String(from?.first_name ?? from?.username ?? 'unknown'),
      content: text,
      timestamp: new Date((msg.date as number) * 1000).toISOString(),
      conversationId: String(chat?.id),
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        chatId: String(chat?.id),
        chatType: chat?.type,
        username: from?.username ? String(from.username) : undefined,
        isCommand: typeof text === 'string' && text.startsWith('/'),
        replyToMessageId: msg.reply_to_message
          ? String((msg.reply_to_message as Record<string, unknown>).message_id)
          : undefined,
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
        allowed_updates: ['message', 'callback_query'],
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
      const text = await response.text().catch(() => '');
      throw new Error(`Telegram API ${method}: ${response.status} ${text}`);
    }

    return response.json() as Promise<Record<string, unknown>>;
  }
}

/**
 * Convert markdown (from Assistant) to Telegram MarkdownV2 format.
 * Telegram MarkdownV2 requires escaping special characters outside of entities.
 */
function markdownToTelegram(text: string): string {
  // Characters that must be escaped in MarkdownV2
  const SPECIAL = /([_\[\]()~`>#+\-=|{}.!\\])/g;

  const lines = text.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    let converted = line;

    // Convert **bold** → *bold*
    converted = converted.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
      return `*${escapeSpecial(inner, SPECIAL)}*`;
    });

    // Convert `code` → `code` (already correct, but escape inside)
    converted = converted.replace(/`([^`]+)`/g, (_, inner) => {
      return '`' + inner + '`';
    });

    // Convert ```code blocks``` → ```code blocks```
    if (converted.startsWith('```')) {
      result.push(converted);
      continue;
    }

    // Convert [text](url) → [text](url) (escape text part)
    converted = converted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
      return `[${escapeSpecial(linkText, SPECIAL)}](${url})`;
    });

    // Convert - list items → • (Telegram renders better with bullet)
    if (/^(\s*)- (.+)/.test(converted)) {
      converted = converted.replace(/^(\s*)- (.+)/, (_, indent, content) => {
        // Don't double-process if already handled by bold/code above
        if (content.includes('*') || content.includes('`') || content.includes('[')) {
          return `${indent}• ${content}`;
        }
        return `${indent}• ${escapeSpecial(content, SPECIAL)}`;
      });
      result.push(converted);
      continue;
    }

    // Convert headers: # Header → *Header* (bold in Telegram)
    if (/^#{1,3}\s+(.+)/.test(converted)) {
      converted = converted.replace(/^#{1,3}\s+(.+)/, (_, heading) => {
        return `*${escapeSpecial(heading, SPECIAL)}*`;
      });
      result.push(converted);
      continue;
    }

    // Escape remaining special chars (but not inside already-formatted entities)
    if (!converted.includes('*') && !converted.includes('`') && !converted.includes('[')) {
      converted = escapeSpecial(converted, SPECIAL);
    }

    result.push(converted);
  }

  return result.join('\n');
}

function escapeSpecial(text: string, pattern: RegExp): string {
  return text.replace(pattern, '\\$1');
}

/**
 * Split a message into chunks that fit Telegram's max length,
 * breaking at newlines when possible.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point (prefer double newline, then single, then space)
    let breakAt = remaining.lastIndexOf('\n\n', maxLength);
    if (breakAt < maxLength * 0.3) breakAt = remaining.lastIndexOf('\n', maxLength);
    if (breakAt < maxLength * 0.3) breakAt = remaining.lastIndexOf(' ', maxLength);
    if (breakAt < maxLength * 0.3) breakAt = maxLength;

    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }

  return chunks;
}
