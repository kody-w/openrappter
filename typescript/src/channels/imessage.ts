/**
 * iMessage Channel (macOS only)
 * Uses AppleScript or BlueBubbles API for iMessage integration
 */

import { EventEmitter } from 'events';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

const execAsync = promisify(exec);

export interface IMessageConfig extends ChannelConfig {
  mode: 'applescript' | 'bluebubbles';
  blueBubblesUrl?: string;
  blueBubblesPassword?: string;
  pollInterval?: number;
}

interface BlueBubblesMessage {
  guid: string;
  text: string;
  dateCreated: number;
  isFromMe: boolean;
  handle?: {
    address: string;
    country?: string;
  };
  chats?: Array<{
    guid: string;
    displayName?: string;
    participants?: Array<{ address: string }>;
  }>;
  attachments?: Array<{
    guid: string;
    mimeType: string;
    transferName: string;
    filePath?: string;
  }>;
}

export class IMessageChannel extends EventEmitter {
  private config: IMessageConfig;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private isConnected = false;
  private pollTimer?: NodeJS.Timeout;
  private lastMessageTime = Date.now();
  private seenMessageIds = new Set<string>();

  constructor(config: IMessageConfig) {
    super();
    this.config = {
      enabled: true,
      mode: 'applescript',
      pollInterval: 5000,
      ...config,
    };
  }

  get id(): string {
    return 'imessage';
  }

  get type(): string {
    return 'imessage';
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to iMessage
   */
  async connect(): Promise<void> {
    // Check if running on macOS
    if (process.platform !== 'darwin') {
      throw new Error('iMessage channel is only supported on macOS');
    }

    if (this.config.mode === 'applescript') {
      await this.connectAppleScript();
    } else {
      await this.connectBlueBubbles();
    }

    this.isConnected = true;
    console.log('iMessage connected');
    this.emit('connected');
  }

  /**
   * Connect using AppleScript polling
   */
  private async connectAppleScript(): Promise<void> {
    // Start polling for new messages
    this.lastMessageTime = Date.now();
    this.pollTimer = setInterval(() => this.pollAppleScriptMessages(), this.config.pollInterval!);
  }

  /**
   * Connect to BlueBubbles server
   */
  private async connectBlueBubbles(): Promise<void> {
    if (!this.config.blueBubblesUrl) {
      throw new Error('BlueBubbles URL is required');
    }

    // Test connection
    const response = await fetch(`${this.config.blueBubblesUrl}/api/v1/server/info`, {
      headers: this.getBlueBubblesHeaders(),
    });

    if (!response.ok) {
      throw new Error('Failed to connect to BlueBubbles');
    }

    // Start polling for new messages
    this.lastMessageTime = Date.now();
    this.pollTimer = setInterval(() => this.pollBlueBubblesMessages(), this.config.pollInterval!);
  }

  /**
   * Disconnect from iMessage
   */
  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.isConnected = false;
    this.emit('disconnected');
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (this.config.mode === 'applescript') {
      await this.sendAppleScript(conversationId, message);
    } else {
      await this.sendBlueBubbles(conversationId, message);
    }
  }

  /**
   * Send via AppleScript
   */
  private async sendAppleScript(conversationId: string, message: OutgoingMessage): Promise<void> {
    // Escape special characters for AppleScript
    const escapedContent = message.content
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${conversationId}" of targetService
        send "${escapedContent}" to targetBuddy
      end tell
    `;

    try {
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    } catch (error) {
      throw new Error(`Failed to send iMessage: ${(error as Error).message}`);
    }
  }

  /**
   * Send via BlueBubbles
   */
  private async sendBlueBubbles(conversationId: string, message: OutgoingMessage): Promise<void> {
    const response = await fetch(`${this.config.blueBubblesUrl}/api/v1/message/text`, {
      method: 'POST',
      headers: {
        ...this.getBlueBubblesHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chatGuid: conversationId,
        message: message.content,
        method: 'private-api',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send iMessage via BlueBubbles: ${error}`);
    }
  }

  /**
   * Set message handler
   */
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Poll for new messages via AppleScript
   */
  private async pollAppleScriptMessages(): Promise<void> {
    if (!this.messageHandler) return;

    try {
      // Query messages database directly (requires Full Disk Access)
      const query = `
        SELECT
          m.guid,
          m.text,
          m.date / 1000000000 + 978307200 as timestamp,
          m.is_from_me,
          h.id as sender,
          c.display_name,
          c.chat_identifier
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE m.date / 1000000000 + 978307200 > ${this.lastMessageTime / 1000}
          AND m.is_from_me = 0
        ORDER BY m.date ASC
        LIMIT 100
      `;

      const dbPath = `${process.env.HOME}/Library/Messages/chat.db`;
      const result = execSync(`sqlite3 -json "${dbPath}" "${query}"`, { encoding: 'utf-8' });

      if (!result.trim()) return;

      const messages = JSON.parse(result) as Array<{
        guid: string;
        text: string;
        timestamp: number;
        is_from_me: number;
        sender: string;
        display_name: string | null;
        chat_identifier: string;
      }>;

      for (const msg of messages) {
        if (this.seenMessageIds.has(msg.guid)) continue;
        this.seenMessageIds.add(msg.guid);

        const incoming: IncomingMessage = {
          id: msg.guid,
          channel: 'imessage',
          conversationId: msg.chat_identifier,
          senderId: msg.sender,
          content: msg.text || '',
          timestamp: new Date(msg.timestamp * 1000).toISOString(),
          attachments: [],
          metadata: {
            displayName: msg.display_name,
          },
        };

        this.lastMessageTime = Math.max(this.lastMessageTime, msg.timestamp * 1000);
        this.messageHandler(incoming);
      }

      // Limit seen messages set size
      if (this.seenMessageIds.size > 1000) {
        const arr = Array.from(this.seenMessageIds);
        this.seenMessageIds = new Set(arr.slice(-500));
      }
    } catch (error) {
      // Silently ignore polling errors
      console.debug('iMessage poll error:', (error as Error).message);
    }
  }

  /**
   * Poll for new messages via BlueBubbles
   */
  private async pollBlueBubblesMessages(): Promise<void> {
    if (!this.messageHandler) return;

    try {
      const response = await fetch(
        `${this.config.blueBubblesUrl}/api/v1/message?` +
          new URLSearchParams({
            after: String(this.lastMessageTime),
            limit: '100',
            with: 'handle,chat,attachment',
          }),
        {
          headers: this.getBlueBubblesHeaders(),
        }
      );

      if (!response.ok) return;

      const data = (await response.json()) as { data: BlueBubblesMessage[] };

      for (const msg of data.data) {
        if (msg.isFromMe) continue;
        if (this.seenMessageIds.has(msg.guid)) continue;
        this.seenMessageIds.add(msg.guid);

        const chatGuid = msg.chats?.[0]?.guid ?? msg.handle?.address ?? '';

        const incoming: IncomingMessage = {
          id: msg.guid,
          channel: 'imessage',
          conversationId: chatGuid,
          senderId: msg.handle?.address ?? '',
          content: msg.text || '',
          timestamp: new Date(msg.dateCreated).toISOString(),
          attachments: this.extractBlueBubblesAttachments(msg.attachments),
          metadata: {
            chatName: msg.chats?.[0]?.displayName,
          },
        };

        this.lastMessageTime = Math.max(this.lastMessageTime, msg.dateCreated);
        this.messageHandler(incoming);
      }
    } catch (error) {
      console.debug('BlueBubbles poll error:', (error as Error).message);
    }
  }

  /**
   * Extract attachments from BlueBubbles message
   */
  private extractBlueBubblesAttachments(
    attachments?: BlueBubblesMessage['attachments']
  ): Attachment[] {
    if (!attachments) return [];

    return attachments.map((att) => ({
      type: this.getAttachmentType(att.mimeType),
      mimeType: att.mimeType,
      filename: att.transferName,
      url: att.filePath,
    }));
  }

  /**
   * Get attachment type from MIME type
   */
  private getAttachmentType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Get BlueBubbles auth headers
   */
  private getBlueBubblesHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.blueBubblesPassword) {
      headers['password'] = this.config.blueBubblesPassword;
    }
    return headers;
  }

  /**
   * Get conversation info
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    return {
      id: conversationId,
      name: conversationId,
      type: conversationId.includes(';') ? 'group' : 'dm',
      participants: [],
    };
  }
}

export function createIMessageChannel(config: IMessageConfig): IMessageChannel {
  return new IMessageChannel(config);
}
