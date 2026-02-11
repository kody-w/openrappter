/**
 * WhatsApp Channel
 * Uses @whiskeysockets/baileys for WhatsApp Web API
 */

import { EventEmitter } from 'events';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

// Types for Baileys (dynamically imported)
interface WASocket {
  ev: EventEmitter;
  user?: { id: string; name?: string };
  sendMessage(jid: string, content: WAMessageContent): Promise<unknown>;
  logout(): Promise<void>;
}

interface WAMessageContent {
  text?: string;
  image?: { url: string } | Buffer;
  audio?: { url: string } | Buffer;
  video?: { url: string } | Buffer;
  document?: { url: string } | Buffer;
  mimetype?: string;
  fileName?: string;
  caption?: string;
}

interface WAMessage {
  key: { remoteJid: string; id: string; fromMe: boolean };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
    imageMessage?: { url?: string; mimetype?: string; caption?: string };
    audioMessage?: { url?: string; mimetype?: string };
    videoMessage?: { url?: string; mimetype?: string; caption?: string };
    documentMessage?: { url?: string; mimetype?: string; fileName?: string };
  };
  pushName?: string;
  messageTimestamp?: number;
}

interface WAConnectionState {
  connection: 'close' | 'open' | 'connecting';
  lastDisconnect?: { error?: Error; date?: Date };
  qr?: string;
}

export interface WhatsAppConfig extends ChannelConfig {
  sessionPath?: string;
  printQRInTerminal?: boolean;
  browser?: [string, string, string];
}

export class WhatsAppChannel extends EventEmitter {
  private sock: WASocket | null = null;
  private config: WhatsAppConfig;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnecting = false;

  constructor(config: WhatsAppConfig) {
    super();
    this.config = {
      enabled: true,
      ...config,
    };
  }

  get id(): string {
    return 'whatsapp';
  }

  get type(): string {
    return 'whatsapp';
  }

  get connected(): boolean {
    return !!this.sock?.user;
  }

  /**
   * Connect to WhatsApp
   */
  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Dynamic import of baileys
      const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
      } = await import('@whiskeysockets/baileys');

      const { state, saveCreds } = await useMultiFileAuthState(
        this.config.sessionPath ?? '.whatsapp-session'
      );

      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: this.config.printQRInTerminal ?? true,
        browser: this.config.browser ?? ['OpenRappter', 'Chrome', '120.0'],
      }) as unknown as WASocket;

      // Handle credentials update
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection state
      this.sock.ev.on('connection.update', (update: Partial<WAConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.emit('qr', qr);
        }

        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as unknown as { output?: { statusCode?: number } })?.output
              ?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(
              `WhatsApp connection closed, reconnecting (attempt ${this.reconnectAttempts})...`
            );
            setTimeout(() => this.connect(), 5000);
          } else {
            console.log('WhatsApp connection closed permanently');
            this.emit('disconnected');
          }
        } else if (connection === 'open') {
          this.reconnectAttempts = 0;
          console.log(`WhatsApp connected as ${this.sock?.user?.name ?? this.sock?.user?.id}`);
          this.emit('connected');
        }
      });

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', (upsert: { messages: WAMessage[]; type: string }) => {
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
          if (msg.key.fromMe) continue;
          this.handleIncomingMessage(msg);
        }
      });
    } catch (error) {
      this.isConnecting = false;
      throw new Error(
        `Failed to connect to WhatsApp: ${(error as Error).message}. ` +
          `Make sure @whiskeysockets/baileys is installed: npm install @whiskeysockets/baileys`
      );
    }

    this.isConnecting = false;
  }

  /**
   * Disconnect from WhatsApp
   */
  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    if (!this.sock) {
      throw new Error('WhatsApp not connected');
    }

    const jid = conversationId.includes('@') ? conversationId : `${conversationId}@s.whatsapp.net`;

    // Handle attachments
    if (message.attachments && message.attachments.length > 0) {
      for (const attachment of message.attachments) {
        await this.sendAttachment(jid, attachment, message.content);
      }
      return;
    }

    // Send text message
    await this.sock.sendMessage(jid, { text: message.content });
  }

  /**
   * Send an attachment
   */
  private async sendAttachment(
    jid: string,
    attachment: Attachment,
    caption?: string
  ): Promise<void> {
    if (!this.sock) return;

    const content: WAMessageContent = {};

    switch (attachment.type) {
      case 'image':
        content.image = attachment.url ? { url: attachment.url } : Buffer.from(attachment.data!, 'base64');
        content.caption = caption;
        break;
      case 'audio':
        content.audio = attachment.url ? { url: attachment.url } : Buffer.from(attachment.data!, 'base64');
        content.mimetype = attachment.mimeType;
        break;
      case 'document':
        content.document = attachment.url ? { url: attachment.url } : Buffer.from(attachment.data!, 'base64');
        content.mimetype = attachment.mimeType;
        content.fileName = attachment.filename;
        break;
      default:
        // Default to document for unknown types
        content.document = attachment.url ? { url: attachment.url } : Buffer.from(attachment.data!, 'base64');
        content.mimetype = attachment.mimeType;
        content.fileName = attachment.filename;
    }

    await this.sock.sendMessage(jid, content);
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
  private handleIncomingMessage(msg: WAMessage): void {
    if (!this.messageHandler) return;

    const content = this.extractContent(msg);
    if (!content) return;

    const jid = msg.key.remoteJid!;
    const isGroup = jid.endsWith('@g.us');

    const incoming: IncomingMessage = {
      id: msg.key.id!,
      channel: 'whatsapp',
      conversationId: jid,
      senderId: isGroup ? jid.split('@')[0] : msg.pushName ?? jid.split('@')[0],
      content,
      timestamp: new Date((msg.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString(),
      attachments: this.extractAttachments(msg),
      metadata: {
        isGroup,
        pushName: msg.pushName,
      },
    };

    this.messageHandler(incoming);
  }

  /**
   * Extract text content from message
   */
  private extractContent(msg: WAMessage): string | null {
    const m = msg.message;
    if (!m) return null;

    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      null
    );
  }

  /**
   * Extract attachments from message
   */
  private extractAttachments(msg: WAMessage): Attachment[] {
    const m = msg.message;
    if (!m) return [];

    const attachments: Attachment[] = [];

    if (m.imageMessage) {
      attachments.push({
        type: 'image',
        url: m.imageMessage.url,
        mimeType: m.imageMessage.mimetype ?? 'image/jpeg',
      });
    }

    if (m.audioMessage) {
      attachments.push({
        type: 'audio',
        url: m.audioMessage.url,
        mimeType: m.audioMessage.mimetype ?? 'audio/ogg',
      });
    }

    if (m.videoMessage) {
      attachments.push({
        type: 'image', // Treat video as image for now
        url: m.videoMessage.url,
        mimeType: m.videoMessage.mimetype ?? 'video/mp4',
      });
    }

    if (m.documentMessage) {
      attachments.push({
        type: 'document',
        url: m.documentMessage.url,
        mimeType: m.documentMessage.mimetype ?? 'application/octet-stream',
        filename: m.documentMessage.fileName,
      });
    }

    return attachments;
  }

  /**
   * Get conversation info
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    const isGroup = conversationId.endsWith('@g.us');

    return {
      id: conversationId,
      name: conversationId.split('@')[0],
      type: isGroup ? 'group' : 'dm',
      participants: [],
    };
  }
}

export function createWhatsAppChannel(config: WhatsAppConfig): WhatsAppChannel {
  return new WhatsAppChannel(config);
}
