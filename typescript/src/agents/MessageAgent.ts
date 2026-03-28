/**
 * MessageAgent - Multi-channel messaging agent.
 *
 * Sends messages and queries channel status across messaging platforms.
 * Integrates with the channel registry for platform-agnostic messaging.
 *
 * Actions: send, list_channels, channel_status
 */

import { BasicAgent } from './BasicAgent.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { AgentMetadata } from './types.js';

const execAsync = promisify(exec);

export class MessageAgent extends BasicAgent {
  private channelRegistry: any = null;
  private static MAX_IMESSAGES_PER_HOUR = 10;
  private iMessageSendTimes: number[] = [];

  constructor(channelRegistry?: any) {
    const metadata: AgentMetadata = {
      name: 'Message',
      description:
        'Send messages to people via iMessage, Telegram, Slack, Discord, and more. ' +
        'For iMessage, use channelId "imessage" and set recipient to the person\'s email or phone number (e.g. "rappter1@icloud.com" or "+15551234567"). ' +
        'For Telegram, use channelId "telegram" with the chat ID.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The messaging action to perform.',
            enum: ['send', 'list_channels', 'channel_status'],
          },
          channelId: {
            type: 'string',
            description: "Channel ID for the message (for 'send' and 'channel_status' actions). Use 'imessage' for iMessage.",
          },
          recipient: {
            type: 'string',
            description: "Recipient identifier — email or phone for iMessage, chat ID for Telegram. Alias for conversationId.",
          },
          conversationId: {
            type: 'string',
            description: "Conversation or thread ID (for 'send' action). For iMessage, this is the recipient's email or phone.",
          },
          content: {
            type: 'string',
            description: "Message content to send (for 'send' action).",
          },
        },
        required: [],
      },
    };
    super('Message', metadata);
    this.channelRegistry = channelRegistry;
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = kwargs.action as string | undefined;
    const channelId = kwargs.channelId as string | undefined;
    const conversationId = (kwargs.recipient as string) || (kwargs.conversationId as string) || undefined;
    const content = kwargs.content as string | undefined;

    if (!action) {
      return JSON.stringify({
        status: 'error',
        message: 'No action specified. Use: send, list_channels, or channel_status',
      });
    }

    try {
      switch (action) {
        case 'send':
          if (!channelId || !conversationId || !content) {
            return JSON.stringify({
              status: 'error',
              message: 'channelId, conversationId, and content required for send action',
            });
          }
          return await this.sendMessage(channelId, conversationId, content);

        case 'list_channels':
          return this.listChannels();

        case 'channel_status':
          if (!channelId) {
            return JSON.stringify({ status: 'error', message: 'channelId required for channel_status action' });
          }
          return this.getChannelStatus(channelId);

        default:
          return JSON.stringify({
            status: 'error',
            message: `Unknown action: ${action}`,
          });
      }
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        action,
        message: (error as Error).message,
      });
    }
  }

  private async sendMessage(channelId: string, conversationId: string, content: string): Promise<string> {
    // Try channel registry first (daemon mode)
    if (this.channelRegistry) {
      const channel = this.channelRegistry.get(channelId);
      if (channel) {
        await channel.sendMessage(conversationId, content);
        return JSON.stringify({
          status: 'success',
          action: 'send',
          channelId,
          conversationId,
          message: 'Message sent successfully',
        });
      }
    }

    // Fallback: send directly via platform APIs (interactive mode)
    const ch = channelId.toLowerCase();
    if (ch === 'imessage' || ch === 'imsg') {
      return this.sendIMessageDirect(conversationId, content);
    }
    if (ch.includes('telegram') || ch === 'tg') {
      return this.sendTelegramDirect(conversationId, content);
    }

    return JSON.stringify({
      status: 'error',
      message: this.channelRegistry
        ? `Channel not found: ${channelId}`
        : 'Channel registry not available. Use channelId "imessage" or "telegram" for direct send.',
    });
  }

  private async sendTelegramDirect(chatId: string, content: string): Promise<string> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      return JSON.stringify({
        status: 'error',
        message: 'No TELEGRAM_BOT_TOKEN set. Run: openrappter onboard',
      });
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: content,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      // If chat_id is missing/wrong, suggest how to find it
      if (errBody.includes('chat not found') || errBody.includes('Bad Request')) {
        return JSON.stringify({
          status: 'error',
          message: `Telegram API error: ${errBody}. Make sure the chat ID is correct. Send /start to the bot first, then check for your chat ID.`,
        });
      }
      return JSON.stringify({
        status: 'error',
        message: `Telegram API error: HTTP ${res.status} — ${errBody}`,
      });
    }

    return JSON.stringify({
      status: 'success',
      action: 'send',
      channelId: 'telegram',
      conversationId: chatId,
      message: 'Message sent via Telegram',
    });
  }

  private async sendIMessageDirect(recipient: string, content: string): Promise<string> {
    if (process.platform !== 'darwin') {
      return JSON.stringify({ status: 'error', message: 'iMessage is only available on macOS' });
    }

    // Allowed contacts check (deny-by-default: empty list = nobody)
    const allowed = (process.env.IMESSAGE_ALLOWED_CONTACTS || '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) {
      return JSON.stringify({
        status: 'error',
        message: 'No allowed iMessage contacts configured. Set IMESSAGE_ALLOWED_CONTACTS in .env (comma-separated emails/phones).',
      });
    }
    if (!allowed.includes(recipient.toLowerCase())) {
      return JSON.stringify({
        status: 'error',
        message: `Recipient "${recipient}" is not in the allowed contacts list. Allowed: ${allowed.join(', ')}`,
      });
    }

    // Rate limiting
    const now = Date.now();
    this.iMessageSendTimes = this.iMessageSendTimes.filter(t => now - t < 3_600_000);
    if (this.iMessageSendTimes.length >= MessageAgent.MAX_IMESSAGES_PER_HOUR) {
      return JSON.stringify({
        status: 'error',
        message: `Rate limit: max ${MessageAgent.MAX_IMESSAGES_PER_HOUR} iMessages per hour`,
      });
    }

    // Send via AppleScript
    const escapedContent = content
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${recipient}" of targetService
        send "${escapedContent}" to targetBuddy
      end tell
    `;

    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 });
      this.iMessageSendTimes.push(now);
      return JSON.stringify({
        status: 'success',
        action: 'send',
        channelId: 'imessage',
        recipient,
        message: 'iMessage sent successfully',
      });
    } catch (error) {
      return JSON.stringify({
        status: 'error',
        message: `Failed to send iMessage: ${(error as Error).message}`,
      });
    }
  }

  private listChannels(): string {
    if (this.channelRegistry) {
      const channels = this.channelRegistry.listChannels();
      return JSON.stringify({
        status: 'success',
        action: 'list_channels',
        channels,
        count: channels.length,
      });
    }

    // No registry — report what's available via env tokens
    const available: Array<{ id: string; type: string; configured: boolean }> = [];
    if (process.platform === 'darwin' && process.env.IMESSAGE_ALLOWED_CONTACTS) {
      available.push({ id: 'imessage', type: 'imessage', configured: true });
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      available.push({ id: 'telegram', type: 'telegram', configured: true });
    }
    if (process.env.DISCORD_BOT_TOKEN) {
      available.push({ id: 'discord', type: 'discord', configured: true });
    }
    if (process.env.SLACK_BOT_TOKEN) {
      available.push({ id: 'slack', type: 'slack', configured: true });
    }

    return JSON.stringify({
      status: 'success',
      action: 'list_channels',
      channels: available,
      count: available.length,
      note: available.length > 0
        ? 'Direct API mode — channels can send messages without the gateway.'
        : 'No channel tokens configured. Run: openrappter onboard',
    });
  }

  private getChannelStatus(channelId: string): string {
    if (!this.channelRegistry) {
      return JSON.stringify({
        status: 'error',
        message: 'Channel registry not available',
      });
    }

    const channel = this.channelRegistry.get(channelId);
    if (!channel) {
      return JSON.stringify({
        status: 'error',
        message: `Channel not found: ${channelId}`,
      });
    }

    const status = channel.getStatus ? channel.getStatus() : { connected: true };

    return JSON.stringify({
      status: 'success',
      action: 'channel_status',
      channelId,
      ...status,
    });
  }
}
