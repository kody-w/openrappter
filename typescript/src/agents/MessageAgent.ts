/**
 * MessageAgent - Multi-channel messaging agent.
 *
 * Sends messages and queries channel status across messaging platforms.
 * Integrates with the channel registry for platform-agnostic messaging.
 *
 * Actions: send, list_channels, channel_status
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MessageAgent extends BasicAgent {
  private channelRegistry: any = null;

  constructor(channelRegistry?: any) {
    const metadata: AgentMetadata = {
      name: 'Message',
      description: 'Send messages and manage multi-channel communication. Supports Slack, Discord, Telegram, Signal, iMessage, and more.',
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
            description: "Channel ID for the message (for 'send' and 'channel_status' actions).",
          },
          conversationId: {
            type: 'string',
            description: "Conversation or thread ID (for 'send' action).",
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
    const conversationId = kwargs.conversationId as string | undefined;
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

    await channel.sendMessage(conversationId, content);

    return JSON.stringify({
      status: 'success',
      action: 'send',
      channelId,
      conversationId,
      message: 'Message sent successfully',
    });
  }

  private listChannels(): string {
    if (!this.channelRegistry) {
      return JSON.stringify({
        status: 'error',
        message: 'Channel registry not available',
      });
    }

    const channels = this.channelRegistry.listChannels();

    return JSON.stringify({
      status: 'success',
      action: 'list_channels',
      channels,
      count: channels.length,
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
