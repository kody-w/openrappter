/**
 * Matrix Channel
 * Uses matrix-js-sdk for Matrix protocol support
 */

import { EventEmitter } from 'events';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

// Types for matrix-js-sdk (dynamically imported)
interface MatrixClient {
  startClient(opts?: { initialSyncLimit?: number }): Promise<void>;
  stopClient(): void;
  on(event: string, callback: (...args: any[]) => void): void;
  off(event: string, callback: (...args: any[]) => void): void;
  once(event: string, callback: (...args: any[]) => void): void;
  getUserId(): string | null;
  joinRoom(roomIdOrAlias: string): Promise<{ roomId: string }>;
  sendMessage(roomId: string, content: MatrixMessageContent): Promise<{ event_id: string }>;
  sendEvent(roomId: string, eventType: string, content: unknown): Promise<{ event_id: string }>;
  uploadContent(file: Buffer, opts: { name: string; type: string }): Promise<{ content_uri: string }>;
  getRoom(roomId: string): MatrixRoom | null;
  getRooms(): MatrixRoom[];
  setDisplayName(name: string): Promise<void>;
}

interface MatrixRoom {
  roomId: string;
  name: string;
  getJoinedMembers(): MatrixMember[];
  getMember(userId: string): MatrixMember | null;
}

interface MatrixMember {
  userId: string;
  name: string;
}

interface MatrixEvent {
  getType(): string;
  getSender(): string;
  getRoomId(): string;
  getId(): string;
  getContent(): MatrixMessageContent;
  getDate(): Date | null;
  isEncrypted(): boolean;
}

interface MatrixMessageContent {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  url?: string;
  info?: {
    mimetype?: string;
    size?: number;
    w?: number;
    h?: number;
  };
  'm.relates_to'?: {
    'm.in_reply_to'?: {
      event_id: string;
    };
  };
}

export interface MatrixConfig extends ChannelConfig {
  homeserverUrl: string;
  accessToken?: string;
  userId?: string;
  password?: string;
  deviceId?: string;
  displayName?: string;
  autoJoin?: boolean;
}

export class MatrixChannel extends EventEmitter {
  private config: MatrixConfig;
  private client: MatrixClient | null = null;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private isConnected = false;
  private syncPromise: Promise<void> | null = null;

  constructor(config: MatrixConfig) {
    super();
    this.config = {
      enabled: true,
      autoJoin: true,
      ...config,
    };
  }

  get id(): string {
    return 'matrix';
  }

  get type(): string {
    return 'matrix';
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to Matrix homeserver
   */
  async connect(): Promise<void> {
    if (this.client) return;

    try {
      // Dynamic import of matrix-js-sdk
      const sdk = await import('matrix-js-sdk');

      // Create client
      if (this.config.accessToken && this.config.userId) {
        this.client = sdk.createClient({
          baseUrl: this.config.homeserverUrl,
          accessToken: this.config.accessToken,
          userId: this.config.userId,
          deviceId: this.config.deviceId,
        }) as unknown as MatrixClient;
      } else if (this.config.userId && this.config.password) {
        // Login with password
        const tempClient = sdk.createClient({
          baseUrl: this.config.homeserverUrl,
        });

        const loginResponse = await (tempClient as unknown as {
          login(type: string, params: { user: string; password: string; device_id?: string }): Promise<{
            access_token: string;
            user_id: string;
            device_id: string;
          }>;
        }).login('m.login.password', {
          user: this.config.userId,
          password: this.config.password,
          device_id: this.config.deviceId,
        });

        this.client = sdk.createClient({
          baseUrl: this.config.homeserverUrl,
          accessToken: loginResponse.access_token,
          userId: loginResponse.user_id,
          deviceId: loginResponse.device_id,
        }) as unknown as MatrixClient;
      } else {
        throw new Error('Either accessToken+userId or userId+password is required');
      }

      // Set up event handlers
      this.setupEventHandlers();

      // Start client
      await this.client.startClient({ initialSyncLimit: 10 });

      // Wait for initial sync
      await this.waitForSync();

      // Set display name if configured
      if (this.config.displayName) {
        await this.client.setDisplayName(this.config.displayName);
      }

      this.isConnected = true;
      console.log(`Matrix connected as ${this.client.getUserId()}`);
      this.emit('connected');
    } catch (error) {
      throw new Error(
        `Failed to connect to Matrix: ${(error as Error).message}. ` +
          `Make sure matrix-js-sdk is installed: npm install matrix-js-sdk`
      );
    }
  }

  /**
   * Wait for initial sync to complete
   */
  private waitForSync(): Promise<void> {
    if (!this.client) return Promise.resolve();

    return new Promise((resolve) => {
      const onSync = (state: string) => {
        if (state === 'PREPARED') {
          this.client?.off('sync', onSync);
          resolve();
        }
      };
      this.client!.on('sync', onSync);
    });
  }

  /**
   * Set up Matrix event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    // Handle room messages
    this.client.on('Room.timeline', (event: MatrixEvent, room: MatrixRoom | undefined) => {
      if (!room) return;
      if (event.getType() !== 'm.room.message') return;
      if (event.getSender() === this.client?.getUserId()) return;

      this.handleIncomingMessage(event, room);
    });

    // Handle room invites (auto-join if configured)
    this.client.on('RoomMember.membership', async (event: MatrixEvent, member: MatrixMember) => {
      if (
        this.config.autoJoin &&
        member.userId === this.client?.getUserId() &&
        (event.getContent() as { membership?: string }).membership === 'invite'
      ) {
        try {
          await this.client?.joinRoom(event.getRoomId());
          console.log(`Matrix: Auto-joined room ${event.getRoomId()}`);
        } catch (error) {
          console.error(`Matrix: Failed to join room ${event.getRoomId()}:`, error);
        }
      }
    });

    // Handle sync state changes
    this.client.on('sync', (state: string) => {
      if (state === 'ERROR') {
        console.error('Matrix sync error');
        this.emit('error', new Error('Sync error'));
      }
    });
  }

  /**
   * Disconnect from Matrix
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Matrix not connected');
    }

    // Handle attachments first
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        await this.sendAttachment(conversationId, attachment);
      }
    }

    // Build message content
    const content: MatrixMessageContent = {
      msgtype: 'm.text',
      body: message.content,
    };

    // Add reply reference if specified
    if (message.replyTo) {
      content['m.relates_to'] = {
        'm.in_reply_to': {
          event_id: message.replyTo,
        },
      };
    }

    await this.client.sendMessage(conversationId, content);
  }

  /**
   * Send an attachment
   */
  private async sendAttachment(roomId: string, attachment: Attachment): Promise<void> {
    if (!this.client) return;

    // Upload content
    let contentUri: string;
    if (attachment.data) {
      const buffer = Buffer.from(attachment.data, 'base64');
      const result = await this.client.uploadContent(buffer, {
        name: attachment.filename ?? 'attachment',
        type: attachment.mimeType ?? 'application/octet-stream',
      });
      contentUri = result.content_uri;
    } else if (attachment.url) {
      // For URLs, we can either download and re-upload, or just send a link
      // Here we'll send as a link in the message body
      await this.client.sendMessage(roomId, {
        msgtype: 'm.text',
        body: attachment.url,
      });
      return;
    } else {
      return;
    }

    // Determine message type
    let msgtype: string;
    switch (attachment.type) {
      case 'image':
        msgtype = 'm.image';
        break;
      case 'audio':
        msgtype = 'm.audio';
        break;
      default:
        msgtype = 'm.file';
    }

    await this.client.sendMessage(roomId, {
      msgtype,
      body: attachment.filename ?? 'attachment',
      url: contentUri,
      info: {
        mimetype: attachment.mimeType,
        size: attachment.size,
      },
    });
  }

  /**
   * Set message handler
   */
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Handle incoming message
   */
  private handleIncomingMessage(event: MatrixEvent, room: MatrixRoom): void {
    if (!this.messageHandler) return;

    const content = event.getContent();
    const sender = event.getSender();
    const senderMember = room.getMember(sender);

    const incoming: IncomingMessage = {
      id: event.getId(),
      channel: 'matrix',
      conversationId: room.roomId,
      sender,
      content: content.body || '',
      timestamp: event.getDate()?.toISOString() ?? new Date().toISOString(),
      attachments: this.extractAttachments(content),
      metadata: {
        roomName: room.name,
        senderName: senderMember?.name ?? sender,
        msgtype: content.msgtype,
        encrypted: event.isEncrypted(),
        format: content.format,
        formattedBody: content.formatted_body,
      },
    };

    this.messageHandler(incoming);
  }

  /**
   * Extract attachments from message content
   */
  private extractAttachments(content: MatrixMessageContent): Attachment[] {
    if (!content.url) return [];

    let type: Attachment['type'];
    switch (content.msgtype) {
      case 'm.image':
        type = 'image';
        break;
      case 'm.audio':
        type = 'audio';
        break;
      case 'm.video':
        type = 'image'; // Treat as image for simplicity
        break;
      default:
        type = 'document';
    }

    return [
      {
        type,
        url: content.url,
        mimeType: content.info?.mimetype ?? 'application/octet-stream',
        size: content.info?.size,
      },
    ];
  }

  /**
   * Join a room
   */
  async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.client) {
      throw new Error('Matrix not connected');
    }

    const result = await this.client.joinRoom(roomIdOrAlias);
    return result.roomId;
  }

  /**
   * Get conversation info
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    if (!this.client) return null;

    const room = this.client.getRoom(conversationId);
    if (!room) return null;

    const members = room.getJoinedMembers();

    return {
      id: room.roomId,
      name: room.name,
      type: members.length > 2 ? 'group' : 'dm',
      participants: members.map((m) => m.userId),
    };
  }

  /**
   * Get all joined rooms
   */
  getRooms(): Array<{ id: string; name: string }> {
    if (!this.client) return [];

    return this.client.getRooms().map((room) => ({
      id: room.roomId,
      name: room.name,
    }));
  }
}

export function createMatrixChannel(config: MatrixConfig): MatrixChannel {
  return new MatrixChannel(config);
}
