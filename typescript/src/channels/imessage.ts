/**
 * iMessage Channel (macOS only)
 * Uses AppleScript or BlueBubbles API for iMessage integration
 */

import { EventEmitter } from 'events';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  /** iMessage ID (phone or email) to watch for self-chat messages */
  selfChatId?: string;
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
  private sentByAI = new Set<string>(); // Track AI-sent message timestamps to avoid loops

  constructor(config: IMessageConfig) {
    super();
    this.config = {
      enabled: true,
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
    // Mark this timestamp so we don't process our own reply as input
    const sendTs = String(Math.round(Date.now() / 1000));
    this.sentByAI.add(sendTs);
    // Clean old entries (keep last 20)
    if (this.sentByAI.size > 20) {
      const arr = Array.from(this.sentByAI);
      this.sentByAI = new Set(arr.slice(-10));
    }

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
      // If selfChatId is set, also watch for self-sent messages in that chat
      const selfFilter = this.config.selfChatId
        ? `AND (m.is_from_me = 0 OR c.chat_identifier = '${this.config.selfChatId.replace(/'/g, "''")}')`
        : `AND m.is_from_me = 0`;
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
          ${selfFilter}
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

        // Skip messages sent by the AI (loop prevention)
        const msgTs = String(Math.round(msg.timestamp));
        if (msg.is_from_me && this.sentByAI.has(msgTs)) {
          this.sentByAI.delete(msgTs);
          this.lastMessageTime = Math.max(this.lastMessageTime, msg.timestamp * 1000);
          continue;
        }

        // For self-chat: treat is_from_me messages as user input
        const incoming: IncomingMessage = {
          id: msg.guid,
          channel: 'imessage',
          conversationId: msg.chat_identifier,
          sender: msg.is_from_me ? 'self' : (msg.sender || ''),
          senderName: msg.is_from_me ? 'Kody' : (msg.display_name || msg.sender || 'unknown'),
          content: msg.text || '',
          timestamp: new Date(msg.timestamp * 1000).toISOString(),
          attachments: [],
          metadata: {
            displayName: msg.display_name,
            isSelfChat: msg.is_from_me === 1,
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
          sender: msg.handle?.address ?? '',
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
   * Generate a voice clip from text and send it as an iMessage audio attachment.
   * Pipeline: macOS `say` → AIFF → ffmpeg → M4A → send via AppleScript
   */
  async sendVoiceClip(conversationId: string, text: string): Promise<boolean> {
    if (process.platform !== 'darwin') return false;

    const tmpDir = os.tmpdir();
    const ts = Date.now();
    const aiffPath = path.join(tmpDir, `openrappter-imsg-${ts}.aiff`);
    const m4aPath = path.join(tmpDir, `openrappter-imsg-${ts}.m4a`);

    try {
      // Clean text for TTS
      const cleaned = text
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]+`/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*_~>]/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[📅🧠🦖❌✅🐊]/gu, '')
        .replace(/"/g, '')
        .replace(/'/g, '')
        .replace(/\n+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 800);

      if (cleaned.length < 5) return false;

      // Generate AIFF with macOS say
      await execAsync(`say -v Samantha -o "${aiffPath}" "${cleaned}"`, { timeout: 30000 });

      // Convert to M4A (iMessage-native format)
      await execAsync(
        `ffmpeg -i "${aiffPath}" -c:a aac -b:a 64k -ar 22050 -ac 1 "${m4aPath}" -y -loglevel error`,
        { timeout: 30000 }
      );

      // Send file via AppleScript
      const script = `
        tell application "Messages"
          set targetService to 1st account whose service type = iMessage
          set targetBuddy to participant "${conversationId}" of targetService
          send POSIX file "${m4aPath}" to targetBuddy
        end tell
      `;
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 15000 });
      return true;
    } catch (err) {
      console.error('iMessage voice clip error:', (err as Error).message);
      return false;
    } finally {
      // Cleanup temp files (delay for AppleScript to finish reading)
      setTimeout(() => {
        try { fs.unlinkSync(aiffPath); } catch {}
        try { fs.unlinkSync(m4aPath); } catch {}
      }, 10000);
    }
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
