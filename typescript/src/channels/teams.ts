/**
 * Microsoft Teams Channel
 * Uses Bot Framework SDK for Teams bot integration
 */

import { EventEmitter } from 'events';
import { createServer, IncomingMessage as HttpRequest, ServerResponse } from 'http';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

// Types for botbuilder (dynamically imported)
interface TurnContext {
  activity: Activity;
  sendActivity(activity: Partial<Activity> | string): Promise<ResourceResponse>;
  sendActivities(activities: Partial<Activity>[]): Promise<ResourceResponse[]>;
}

interface Activity {
  type: string;
  id?: string;
  timestamp?: string;
  channelId?: string;
  from?: ChannelAccount;
  conversation?: ConversationAccount;
  recipient?: ChannelAccount;
  text?: string;
  attachments?: ActivityAttachment[];
  entities?: Entity[];
  channelData?: Record<string, unknown>;
  serviceUrl?: string;
  replyToId?: string;
}

interface ChannelAccount {
  id: string;
  name?: string;
  aadObjectId?: string;
}

interface ConversationAccount {
  id: string;
  name?: string;
  conversationType?: string;
  isGroup?: boolean;
  tenantId?: string;
}

interface ActivityAttachment {
  contentType: string;
  contentUrl?: string;
  content?: unknown;
  name?: string;
}

interface Entity {
  type: string;
  mentioned?: ChannelAccount;
  text?: string;
}

interface ResourceResponse {
  id: string;
}

interface BotFrameworkAdapter {
  processActivity(
    req: HttpRequest,
    res: ServerResponse,
    logic: (context: TurnContext) => Promise<void>
  ): Promise<void>;
  continueConversation(
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>
  ): Promise<void>;
}

interface ConversationReference {
  activityId?: string;
  bot?: ChannelAccount;
  channelId?: string;
  conversation?: ConversationAccount;
  serviceUrl?: string;
  user?: ChannelAccount;
}

export interface TeamsConfig extends ChannelConfig {
  appId: string;
  appPassword: string;
  port?: number;
  tenantId?: string;
  endpoint?: string;
}

export class TeamsChannel extends EventEmitter {
  private config: TeamsConfig;
  private adapter: BotFrameworkAdapter | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private isConnected = false;
  private conversationReferences = new Map<string, Partial<ConversationReference>>();

  constructor(config: TeamsConfig) {
    super();
    this.config = {
      enabled: true,
      port: 3978,
      endpoint: '/api/messages',
      ...config,
    };
  }

  get id(): string {
    return 'teams';
  }

  get type(): string {
    return 'teams';
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to Teams (start bot server)
   */
  async connect(): Promise<void> {
    if (this.server) return;

    try {
      // Dynamic import of botbuilder
      const { BotFrameworkAdapter } = await import('botbuilder');

      this.adapter = new BotFrameworkAdapter({
        appId: this.config.appId,
        appPassword: this.config.appPassword,
      }) as unknown as BotFrameworkAdapter;

      // Create HTTP server
      this.server = createServer((req, res) => this.handleRequest(req, res));

      // Start server
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.config.port, () => {
          resolve();
        });
        this.server!.on('error', reject);
      });

      this.isConnected = true;
      console.log(`Teams bot server listening on port ${this.config.port}`);
      this.emit('connected');
    } catch (error) {
      throw new Error(
        `Failed to start Teams bot: ${(error as Error).message}. ` +
          `Make sure botbuilder is installed: npm install botbuilder`
      );
    }
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: HttpRequest, res: ServerResponse): Promise<void> {
    if (req.url !== this.config.endpoint || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      await this.adapter!.processActivity(req, res, async (context) => {
        await this.handleActivity(context);
      });
    } catch (error) {
      console.error('Teams activity processing error:', error);
      res.writeHead(500);
      res.end();
    }
  }

  /**
   * Handle incoming activity
   */
  private async handleActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Store conversation reference for proactive messaging
    this.storeConversationReference(activity);

    switch (activity.type) {
      case 'message':
        await this.handleMessage(context);
        break;
      case 'conversationUpdate':
        await this.handleConversationUpdate(context);
        break;
      case 'invoke':
        await this.handleInvoke(context);
        break;
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(context: TurnContext): Promise<void> {
    if (!this.messageHandler) return;

    const activity = context.activity;

    // Skip messages from the bot itself
    if (activity.from?.id === activity.recipient?.id) return;

    // Check if bot was mentioned (for channel messages)
    const isMentioned = this.isBotMentioned(activity);
    const text = this.removeBotMention(activity.text ?? '', activity);

    const incoming: IncomingMessage = {
      id: activity.id ?? `teams_${Date.now()}`,
      channel: 'teams',
      conversationId: activity.conversation?.id ?? '',
      senderId: activity.from?.id ?? '',
      content: text,
      timestamp: activity.timestamp ?? new Date().toISOString(),
      attachments: this.extractAttachments(activity.attachments),
      metadata: {
        senderName: activity.from?.name,
        conversationType: activity.conversation?.conversationType,
        isGroup: activity.conversation?.isGroup,
        tenantId: activity.conversation?.tenantId,
        isMentioned,
        replyToId: activity.replyToId,
        channelData: activity.channelData,
      },
    };

    // Attach send function for easy replies
    (incoming as IncomingMessage & { reply: (text: string) => Promise<void> }).reply = async (
      text: string
    ) => {
      await context.sendActivity(text);
    };

    this.messageHandler(incoming);
  }

  /**
   * Handle conversation update (member added/removed)
   */
  private async handleConversationUpdate(context: TurnContext): Promise<void> {
    const activity = context.activity;

    // Welcome new members
    const membersAdded = (activity as Activity & { membersAdded?: ChannelAccount[] }).membersAdded;
    if (membersAdded) {
      for (const member of membersAdded) {
        if (member.id !== activity.recipient?.id) {
          // New user joined
          this.emit('memberAdded', {
            conversationId: activity.conversation?.id,
            member,
          });
        }
      }
    }
  }

  /**
   * Handle invoke activity (adaptive card actions, etc.)
   */
  private async handleInvoke(context: TurnContext): Promise<void> {
    const activity = context.activity;

    this.emit('invoke', {
      name: (activity as Activity & { name?: string }).name,
      value: (activity as Activity & { value?: unknown }).value,
      conversationId: activity.conversation?.id,
    });
  }

  /**
   * Store conversation reference for proactive messaging
   */
  private storeConversationReference(activity: Activity): void {
    const reference: Partial<ConversationReference> = {
      activityId: activity.id,
      bot: activity.recipient,
      channelId: activity.channelId,
      conversation: activity.conversation,
      serviceUrl: activity.serviceUrl,
      user: activity.from,
    };

    if (activity.conversation?.id) {
      this.conversationReferences.set(activity.conversation.id, reference);
    }
  }

  /**
   * Check if bot was mentioned in the message
   */
  private isBotMentioned(activity: Activity): boolean {
    if (!activity.entities) return false;

    return activity.entities.some(
      (entity) =>
        entity.type === 'mention' && entity.mentioned?.id === activity.recipient?.id
    );
  }

  /**
   * Remove bot mention from message text
   */
  private removeBotMention(text: string, activity: Activity): string {
    if (!activity.entities) return text;

    let result = text;
    for (const entity of activity.entities) {
      if (entity.type === 'mention' && entity.mentioned?.id === activity.recipient?.id) {
        result = result.replace(entity.text ?? '', '').trim();
      }
    }

    return result;
  }

  /**
   * Disconnect from Teams
   */
  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!this.adapter) {
      throw new Error('Teams not connected');
    }

    const reference = this.conversationReferences.get(conversationId);
    if (!reference) {
      throw new Error(`No conversation reference found for ${conversationId}`);
    }

    await this.adapter.continueConversation(reference, async (context) => {
      // Build activity
      const activity: Partial<Activity> = {
        type: 'message',
        text: message.content,
      };

      // Add attachments
      if (message.attachments && message.attachments.length > 0) {
        activity.attachments = message.attachments.map((att) => ({
          contentType: att.mimeType,
          contentUrl: att.url,
          name: att.filename,
        }));
      }

      // Add reply reference
      if (message.replyTo) {
        activity.replyToId = message.replyTo;
      }

      await context.sendActivity(activity);
    });
  }

  /**
   * Send an Adaptive Card
   */
  async sendCard(conversationId: string, card: unknown): Promise<void> {
    if (!this.adapter) {
      throw new Error('Teams not connected');
    }

    const reference = this.conversationReferences.get(conversationId);
    if (!reference) {
      throw new Error(`No conversation reference found for ${conversationId}`);
    }

    await this.adapter.continueConversation(reference, async (context) => {
      await context.sendActivity({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: card,
          },
        ],
      });
    });
  }

  /**
   * Set message handler
   */
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Extract attachments from activity
   */
  private extractAttachments(attachments?: ActivityAttachment[]): Attachment[] {
    if (!attachments) return [];

    return attachments
      .filter((att) => att.contentUrl)
      .map((att) => ({
        type: this.getAttachmentType(att.contentType),
        url: att.contentUrl,
        mimeType: att.contentType,
        filename: att.name,
      }));
  }

  /**
   * Get attachment type from content type
   */
  private getAttachmentType(contentType: string): Attachment['type'] {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Get conversation info
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    const reference = this.conversationReferences.get(conversationId);
    if (!reference) return null;

    return {
      id: conversationId,
      name: reference.conversation?.name ?? conversationId,
      type: reference.conversation?.isGroup ? 'group' : 'dm',
      participants: [],
    };
  }

  /**
   * Get all known conversations
   */
  getConversations(): string[] {
    return Array.from(this.conversationReferences.keys());
  }
}

export function createTeamsChannel(config: TeamsConfig): TeamsChannel {
  return new TeamsChannel(config);
}
