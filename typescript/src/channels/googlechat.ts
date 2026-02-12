/**
 * Google Chat Channel
 * Uses Google Chat API for bot integration
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

// Google Chat API types
interface ChatEvent {
  type: 'MESSAGE' | 'ADDED_TO_SPACE' | 'REMOVED_FROM_SPACE' | 'CARD_CLICKED';
  eventTime: string;
  space?: Space;
  message?: ChatMessage;
  user?: User;
  action?: CardAction;
}

interface Space {
  name: string;
  type: 'ROOM' | 'DM';
  displayName?: string;
  threaded?: boolean;
}

interface ChatMessage {
  name: string;
  sender?: User;
  createTime?: string;
  text?: string;
  cards?: Card[];
  attachment?: ChatAttachment[];
  thread?: Thread;
  argumentText?: string;
  annotations?: Annotation[];
}

interface User {
  name: string;
  displayName?: string;
  type: 'HUMAN' | 'BOT';
  domainId?: string;
}

interface Thread {
  name: string;
}

interface Card {
  header?: CardHeader;
  sections?: CardSection[];
}

interface CardHeader {
  title?: string;
  subtitle?: string;
  imageUrl?: string;
}

interface CardSection {
  header?: string;
  widgets?: Widget[];
}

interface Widget {
  textParagraph?: { text: string };
  image?: { imageUrl: string; onClick?: OnClick };
  buttons?: Button[];
  keyValue?: KeyValue;
}

interface Button {
  textButton?: { text: string; onClick?: OnClick };
  imageButton?: { iconUrl: string; onClick?: OnClick };
}

interface KeyValue {
  topLabel?: string;
  content?: string;
  bottomLabel?: string;
}

interface OnClick {
  openLink?: { url: string };
  action?: {
    actionMethodName: string;
    parameters?: Array<{ key: string; value: string }>;
  };
}

interface ChatAttachment {
  name: string;
  contentType: string;
  attachmentDataRef?: {
    resourceName: string;
  };
  thumbnailUri?: string;
  downloadUri?: string;
}

interface Annotation {
  type: 'USER_MENTION' | 'SLASH_COMMAND';
  startIndex?: number;
  length?: number;
  userMention?: {
    user: User;
    type: 'MENTION' | 'MENTION_ALL';
  };
  slashCommand?: {
    commandName: string;
    commandId: number;
    triggersDialog?: boolean;
  };
}

interface CardAction {
  actionMethodName: string;
  parameters?: Array<{ key: string; value: string }>;
}

export interface GoogleChatConfig extends ChannelConfig {
  projectId: string;
  credentials?: {
    clientEmail: string;
    privateKey: string;
  };
  credentialsPath?: string;
  port?: number;
  endpoint?: string;
  verificationToken?: string;
}

export class GoogleChatChannel extends EventEmitter {
  private config: GoogleChatConfig;
  private server: ReturnType<typeof createServer> | null = null;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private isConnected = false;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private spaces = new Map<string, Space>();

  constructor(config: GoogleChatConfig) {
    super();
    this.config = {
      enabled: true,
      port: 8080,
      endpoint: '/chat',
      ...config,
    };
  }

  get id(): string {
    return 'googlechat';
  }

  get type(): string {
    return 'googlechat';
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to Google Chat (start webhook server)
   */
  async connect(): Promise<void> {
    if (this.server) return;

    // Create HTTP server for webhooks
    this.server = createServer((req, res) => this.handleRequest(req, res));

    // Start server
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.port, () => {
        resolve();
      });
      this.server!.on('error', reject);
    });

    this.isConnected = true;
    console.log(`Google Chat webhook server listening on port ${this.config.port}`);
    this.emit('connected');
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

    // Read request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    try {
      const event = JSON.parse(body) as ChatEvent;

      // Verify token if configured
      if (this.config.verificationToken) {
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${this.config.verificationToken}`) {
          res.writeHead(401);
          res.end();
          return;
        }
      }

      // Process event
      const response = await this.handleEvent(event);

      // Send response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response ?? {}));
    } catch (error) {
      console.error('Google Chat event processing error:', error);
      res.writeHead(500);
      res.end();
    }
  }

  /**
   * Handle incoming event
   */
  private async handleEvent(event: ChatEvent): Promise<Partial<ChatMessage> | void> {
    // Store space info
    if (event.space) {
      this.spaces.set(event.space.name, event.space);
    }

    switch (event.type) {
      case 'MESSAGE':
        return this.handleMessage(event);

      case 'ADDED_TO_SPACE':
        this.emit('addedToSpace', {
          space: event.space,
          user: event.user,
        });
        // Return welcome message
        return {
          text: 'Thanks for adding me! How can I help?',
        };

      case 'REMOVED_FROM_SPACE':
        if (event.space) {
          this.spaces.delete(event.space.name);
        }
        this.emit('removedFromSpace', { space: event.space });
        break;

      case 'CARD_CLICKED':
        this.emit('cardClicked', {
          action: event.action,
          space: event.space,
          user: event.user,
        });
        break;
    }
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(event: ChatEvent): Promise<Partial<ChatMessage> | void> {
    if (!this.messageHandler) return;
    if (!event.message) return;

    const message = event.message;
    const space = event.space;

    // Extract text, removing bot mention
    let content = message.argumentText ?? message.text ?? '';
    content = content.trim();

    const incoming: IncomingMessage = {
      id: message.name,
      channel: 'googlechat',
      conversationId: space?.name ?? '',
      sender: message.sender?.name ?? '',
      content,
      timestamp: message.createTime ?? new Date().toISOString(),
      attachments: this.extractAttachments(message.attachment),
      metadata: {
        senderName: message.sender?.displayName,
        spaceType: space?.type,
        spaceName: space?.displayName,
        thread: message.thread?.name,
        annotations: message.annotations,
      },
    };

    this.messageHandler(incoming);
  }

  /**
   * Disconnect from Google Chat
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
   * Get access token for API calls
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) {
      return this.accessToken;
    }

    if (!this.config.credentials) {
      throw new Error('Google Chat credentials not configured');
    }

    // Generate JWT for service account auth
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: this.config.credentials.clientEmail,
        scope: 'https://www.googleapis.com/auth/chat.bot',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    ).toString('base64url');

    // Sign JWT (simplified - in production use crypto)
    const crypto = await import('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(this.config.credentials.privateKey, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${await response.text()}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;

    return this.accessToken;
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    const token = await this.getAccessToken();

    const body: Partial<ChatMessage> = {};

    // Text message
    if (message.content) {
      body.text = message.content;
    }

    // Reply to thread
    if (message.replyTo) {
      body.thread = { name: message.replyTo };
    }

    const response = await fetch(
      `https://chat.googleapis.com/v1/${conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to send message: ${await response.text()}`);
    }
  }

  /**
   * Send a card message
   */
  async sendCard(conversationId: string, card: Card, threadKey?: string): Promise<void> {
    const token = await this.getAccessToken();

    const body: Partial<ChatMessage> = {
      cards: [card],
    };

    if (threadKey) {
      body.thread = { name: threadKey };
    }

    const response = await fetch(
      `https://chat.googleapis.com/v1/${conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to send card: ${await response.text()}`);
    }
  }

  /**
   * Set message handler
   */
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Extract attachments from message
   */
  private extractAttachments(attachments?: ChatAttachment[]): Attachment[] {
    if (!attachments) return [];

    return attachments.map((att) => ({
      type: this.getAttachmentType(att.contentType),
      url: att.downloadUri,
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
    const space = this.spaces.get(conversationId);
    if (!space) return null;

    return {
      id: conversationId,
      name: space.displayName ?? conversationId,
      type: space.type === 'DM' ? 'dm' : 'group',
      participants: [],
    };
  }

  /**
   * List known spaces
   */
  getSpaces(): Space[] {
    return Array.from(this.spaces.values());
  }
}

export function createGoogleChatChannel(config: GoogleChatConfig): GoogleChatChannel {
  return new GoogleChatChannel(config);
}
