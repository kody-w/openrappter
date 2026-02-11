/**
 * WhatsApp Channel
 * Uses @whiskeysockets/baileys for WhatsApp Web API
 */

import { BaseChannel } from './base.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

// Types for Baileys (dynamically imported)
interface WASocket {
  ev: { on(event: string, handler: (...args: unknown[]) => void): void };
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

export class WhatsAppChannel extends BaseChannel {
  private sock: WASocket | null = null;
  private config: WhatsAppConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnecting = false;

  constructor(config: WhatsAppConfig) {
    super('whatsapp', 'whatsapp');
    this.config = { enabled: true, ...config };
  }

  async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;
    this.status = 'connecting';

    try {
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

      this.sock.ev.on('creds.update', saveCreds as () => void);

      this.sock.ev.on('connection.update', (...args: unknown[]) => {
        const update = args[0] as Partial<WAConnectionState>;
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          const shouldReconnect =
            (lastDisconnect?.error as unknown as { output?: { statusCode?: number } })?.output
              ?.statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.status = 'connecting';
            setTimeout(() => this.connect().catch(() => {}), 5000);
          } else {
            this.status = 'disconnected';
          }
        } else if (connection === 'open') {
          this.reconnectAttempts = 0;
          this.status = 'connected';
          this.connectedAt = new Date().toISOString();
        }
      });

      this.sock.ev.on('messages.upsert', (...args: unknown[]) => {
        const upsert = args[0] as { messages: WAMessage[]; type: string };
        if (upsert.type !== 'notify') return;

        for (const msg of upsert.messages) {
          if (msg.key.fromMe) continue;
          this.handleIncomingMessage(msg);
        }
      });
    } catch (error) {
      this.isConnecting = false;
      this.status = 'error';
      throw new Error(
        `Failed to connect to WhatsApp: ${(error as Error).message}. ` +
          `Make sure @whiskeysockets/baileys is installed: npm install @whiskeysockets/baileys`
      );
    }

    this.isConnecting = false;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      await this.sock.logout();
      this.sock = null;
    }
    this.status = 'disconnected';
  }

  async send(messageOrId: OutgoingMessage | string, message?: OutgoingMessage): Promise<void> {
    if (!this.sock) throw new Error('WhatsApp not connected');

    const msg = typeof messageOrId === 'string' ? message! : messageOrId;
    const recipient = typeof messageOrId === 'string' ? messageOrId : msg.recipient ?? '';
    const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;

    if (msg.attachments && msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        await this.sendAttachment(jid, attachment, msg.content);
      }
      return;
    }

    await this.sock.sendMessage(jid, { text: msg.content });
    this.messageCount++;
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    const isGroup = conversationId.endsWith('@g.us');
    return {
      id: conversationId,
      name: conversationId.split('@')[0],
      type: isGroup ? 'group' : 'dm',
      participants: [],
    };
  }

  private async sendAttachment(jid: string, attachment: Attachment, caption?: string): Promise<void> {
    if (!this.sock) return;

    const content: WAMessageContent = {};
    const source = attachment.url ? { url: attachment.url } : Buffer.from(attachment.data ?? '', 'base64');

    switch (attachment.type) {
      case 'image':
        content.image = source;
        content.caption = caption;
        break;
      case 'audio':
        content.audio = source;
        content.mimetype = attachment.mimeType;
        break;
      case 'document':
      default:
        content.document = source;
        content.mimetype = attachment.mimeType;
        content.fileName = attachment.filename;
        break;
    }

    await this.sock.sendMessage(jid, content);
    this.messageCount++;
  }

  private handleIncomingMessage(msg: WAMessage): void {
    const content = this.extractContent(msg);
    if (!content) return;

    const jid = msg.key.remoteJid!;
    const isGroup = jid.endsWith('@g.us');

    const incoming: IncomingMessage = {
      id: msg.key.id!,
      channel: 'whatsapp',
      sender: isGroup ? jid.split('@')[0] : msg.pushName ?? jid.split('@')[0],
      content,
      timestamp: new Date((msg.messageTimestamp ?? Date.now() / 1000) * 1000).toISOString(),
      conversationId: jid,
      attachments: this.extractAttachments(msg),
      metadata: { isGroup, pushName: msg.pushName },
    };

    this.emitMessage(incoming);
  }

  private extractContent(msg: WAMessage): string | null {
    const m = msg.message;
    if (!m) return null;
    return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || null;
  }

  private extractAttachments(msg: WAMessage): Attachment[] {
    const m = msg.message;
    if (!m) return [];

    const attachments: Attachment[] = [];

    if (m.imageMessage) {
      attachments.push({ type: 'image', url: m.imageMessage.url, mimeType: m.imageMessage.mimetype ?? 'image/jpeg' });
    }
    if (m.audioMessage) {
      attachments.push({ type: 'audio', url: m.audioMessage.url, mimeType: m.audioMessage.mimetype ?? 'audio/ogg' });
    }
    if (m.videoMessage) {
      attachments.push({ type: 'video', url: m.videoMessage.url, mimeType: m.videoMessage.mimetype ?? 'video/mp4' });
    }
    if (m.documentMessage) {
      attachments.push({
        type: 'document', url: m.documentMessage.url,
        mimeType: m.documentMessage.mimetype ?? 'application/octet-stream',
        filename: m.documentMessage.fileName,
      });
    }

    return attachments;
  }
}

export function createWhatsAppChannel(config: WhatsAppConfig): WhatsAppChannel {
  return new WhatsAppChannel(config);
}
