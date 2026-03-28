/**
 * iMessage Channel (macOS only)
 * Uses AppleScript or BlueBubbles API for iMessage integration
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
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
  /** Additional iMessage IDs (emails/phones) to watch for incoming messages */
  watchContacts?: string[];
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
  private lastMessageRowId = 0; // For sqlite polling — track last seen rowid
  private seenMessageIds = new Set<string>();
  private sentByAI = new Set<string>(); // Track AI-sent message timestamps to avoid loops
  private useSqlite = false; // Whether sqlite3 FDA-based polling is available

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
   * Connect using AppleScript polling (with sqlite upgrade if FDA available)
   */
  private async connectAppleScript(): Promise<void> {
    // Detect if sqlite3 can read the Messages database (requires Full Disk Access)
    try {
      const dbPath = path.join(os.homedir(), 'Library/Messages/chat.db');
      const { stdout } = await execAsync(
        `sqlite3 "${dbPath}" "SELECT MAX(rowid) FROM message" 2>/dev/null`,
        { timeout: 3000 },
      );
      const maxRowId = parseInt(stdout.trim(), 10);
      if (maxRowId > 0) {
        this.useSqlite = true;
        this.lastMessageRowId = maxRowId;
        console.log(`iMessage: using sqlite poller (FDA available, starting from rowid ${maxRowId})`);
      }
    } catch {
      // No FDA — fall back to AppleScript
      console.log('iMessage: using AppleScript poller (no FDA)');
    }

    this.lastMessageTime = Date.now();
    const pollFn = this.useSqlite
      ? () => this.pollSqliteMessages()
      : () => this.pollAppleScriptMessages();
    this.pollTimer = setInterval(pollFn, this.config.pollInterval!);
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
    // Mark content prefix so we don't process our own reply as input
    const contentPrefix = message.content.substring(0, 20);
    this.sentByAI.add(contentPrefix);
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
   * Poll for new messages via AppleScript (no Full Disk Access needed)
   */
  private async pollAppleScriptMessages(): Promise<void> {
    if (!this.messageHandler) return;

    try {
      const selfId = this.config.selfChatId || '';
      const watchIds = this.config.watchContacts || [];
      // Build list of chat identifiers to watch: self-chat + allowed contacts
      const allWatchIds = [selfId, ...watchIds].filter(Boolean);
      if (allWatchIds.length === 0) return;

      // Build AppleScript condition: chatId contains "x" or chatId contains "y"
      const matchCondition = allWatchIds
        .map(id => `chatId contains "${id}"`)
        .join(' or ');

      // Use AppleScript to read messages — bypasses FDA requirement
      const script = `
        tell application "Messages"
          set output to ""
          set allChats to every chat
          repeat with aChat in allChats
            try
              set chatId to id of aChat
              if ${matchCondition} then
                set msgs to messages of aChat
                set msgCount to count of msgs
                if msgCount > 0 then
                  set startIdx to msgCount - 4
                  if startIdx < 1 then set startIdx to 1
                  repeat with i from startIdx to msgCount
                    set aMsg to item i of msgs
                    set msgContent to content of aMsg
                    set msgDate to date string of (date sent of aMsg)
                    set msgTime to time string of (date sent of aMsg)
                    set msgId to id of aMsg
                    set senderName to "unknown"
                    try
                      set senderName to full name of sender of aMsg
                    end try
                    set fromMe to "0"
                    try
                      if sender of aMsg is missing value then set fromMe to "1"
                    end try
                    set output to output & chatId & "|||" & msgId & "|||" & msgContent & "|||" & fromMe & "|||" & senderName & linefeed
                  end repeat
                end if
              end if
            end try
          end repeat
          return output
        end tell
      `;

      const { stdout } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000 });
      if (!stdout.trim()) return;

      const lines = stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('|||');
        if (parts.length < 4) continue;

        const [chatIdentifier, msgId, content, fromMe, senderName] = parts;
        if (!msgId || !content) continue;

        // Skip file transfer / attachment messages — AppleScript returns internal
        // attribute names (e.g. kIMFileTransferGUIDAttributeName) instead of text
        if (content.includes('kIMFileTransfer') || content.includes('kIMBaseWritingDirection')) continue;

        if (this.seenMessageIds.has(msgId)) continue;
        this.seenMessageIds.add(msgId);

        // Determine if this is the self-chat or a contact chat
        const isSelfChat = selfId && chatIdentifier.includes(selfId);

        // Skip messages sent by the AI (loop prevention)
        if (fromMe === '1') {
          const contentPrefix = content.substring(0, 20);
          if (this.sentByAI.has(contentPrefix)) {
            this.sentByAI.delete(contentPrefix);
            continue;
          }
          // In contact chats, skip all fromMe messages (those are our replies)
          if (!isSelfChat) continue;
        }

        // Figure out the conversationId — for contact chats, extract the contact's address
        const contactId = allWatchIds.find(id => chatIdentifier.includes(id)) || chatIdentifier;

        const incoming: IncomingMessage = {
          id: msgId,
          channel: 'imessage',
          conversationId: contactId,
          sender: fromMe === '1' ? 'self' : (senderName || 'unknown'),
          senderName: fromMe === '1' ? 'Kody' : (senderName || 'unknown'),
          content: content,
          timestamp: new Date().toISOString(),
          attachments: [],
          metadata: {
            isSelfChat: !!isSelfChat,
            chatIdentifier,
          },
        };

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
   * Poll for new messages via sqlite3 (requires Full Disk Access)
   * More reliable than AppleScript — reads directly from chat.db
   */
  private async pollSqliteMessages(): Promise<void> {
    if (!this.messageHandler) return;

    try {
      const selfId = this.config.selfChatId || '';
      const watchIds = this.config.watchContacts || [];
      const allWatchIds = [selfId, ...watchIds].filter(Boolean);
      if (allWatchIds.length === 0) return;

      // Build WHERE clause for watched contacts
      const chatFilter = allWatchIds.map(id => `c.chat_identifier = '${id.replace(/'/g, "''")}'`).join(' OR ');
      const dbPath = path.join(os.homedir(), 'Library/Messages/chat.db');

      const query = `
        SELECT m.rowid, m.text, m.is_from_me, c.chat_identifier,
               COALESCE(h.id, '') as sender_id
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.rowid
        JOIN chat c ON c.rowid = cmj.chat_id
        LEFT JOIN handle h ON m.handle_id = h.rowid
        WHERE m.rowid > ${this.lastMessageRowId}
          AND (${chatFilter})
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.rowid ASC
        LIMIT 20
      `.replace(/\n/g, ' ');

      const { stdout } = await execAsync(
        `sqlite3 -separator '|||' "${dbPath}" "${query.replace(/"/g, '\\"')}"`,
        { timeout: 5000 },
      );

      if (!stdout.trim()) return;

      const lines = stdout.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('|||');
        if (parts.length < 4) continue;

        const [rowIdStr, content, isFromMeStr, chatIdentifier, senderId] = parts;
        const rowId = parseInt(rowIdStr, 10);
        const isFromMe = isFromMeStr === '1';

        if (!content || !rowId) continue;

        // Update high-water mark
        if (rowId > this.lastMessageRowId) {
          this.lastMessageRowId = rowId;
        }

        // Skip file transfer metadata
        if (content.includes('kIMFileTransfer') || content.includes('kIMBaseWritingDirection')) continue;

        // Determine if this is the self-chat
        const isSelfChat = selfId && chatIdentifier === selfId;

        // In contact chats, skip our own outbound messages (loop prevention)
        if (isFromMe && !isSelfChat) continue;

        // In self-chat, skip AI-sent messages
        if (isFromMe && isSelfChat) {
          const contentPrefix = content.substring(0, 20);
          if (this.sentByAI.has(contentPrefix)) {
            this.sentByAI.delete(contentPrefix);
            continue;
          }
        }

        const incoming: IncomingMessage = {
          id: `sqlite-${rowId}`,
          channel: 'imessage',
          conversationId: chatIdentifier,
          sender: isFromMe ? 'self' : (senderId || 'unknown'),
          senderName: isFromMe ? 'Kody' : (senderId || 'unknown'),
          content,
          timestamp: new Date().toISOString(),
          attachments: [],
          metadata: {
            isSelfChat: !!isSelfChat,
            chatIdentifier,
            rowId,
          },
        };

        this.messageHandler(incoming);
      }
    } catch (error) {
      console.debug('iMessage sqlite poll error:', (error as Error).message);
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
