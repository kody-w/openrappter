/**
 * Discord channel implementation using Discord.js WebSocket gateway
 */

import { BaseChannel } from './base.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
} from './types.js';
import { WebSocket } from 'ws';

export interface DiscordConfig extends ChannelConfig {
  botToken: string;
  allowedGuildIds?: string[];
  allowedChannelIds?: string[];
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url: string;
    size: number;
  }>;
}

interface DiscordPayload {
  op: number;
  d: unknown;
  s?: number;
  t?: string;
}

/**
 * Discord Bot Channel
 */
export class DiscordChannel extends BaseChannel {
  id: string;
  name: string;

  private botToken: string;
  private allowedGuildIds: Set<string>;
  private allowedChannelIds: Set<string>;
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private baseUrl = 'https://discord.com/api/v10';
  private gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';

  constructor(id: string, name: string, config: DiscordConfig) {
    super();
    this.id = id;
    this.name = name;
    this.botToken = config.botToken;
    this.allowedGuildIds = new Set(config.allowedGuildIds ?? []);
    this.allowedChannelIds = new Set(config.allowedChannelIds ?? []);
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.on('open', () => {
        // Connection opened, wait for HELLO
      });

      this.ws.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as DiscordPayload;
        this.handlePayload(payload);

        if (payload.op === 10) {
          // HELLO received, now connected
          this.connected = true;
          resolve();
        }
      });

      this.ws.on('error', (error) => {
        reject(error);
      });

      this.ws.on('close', () => {
        if (this.connected) {
          // Attempt reconnect
          setTimeout(() => this.connect(), 5000);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
  }

  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    const body: Record<string, unknown> = {
      content: message.content,
    };

    if (message.replyTo) {
      body.message_reference = {
        message_id: message.replyTo,
      };
    }

    // Handle attachments (would need multipart form data for files)
    if (message.attachments?.length) {
      const embeds = message.attachments
        .filter(a => a.url)
        .map(a => ({
          image: a.type === 'image' ? { url: a.url } : undefined,
          title: a.filename,
        }));

      if (embeds.length > 0) {
        body.embeds = embeds;
      }
    }

    await this.callApi('POST', `/channels/${conversationId}/messages`, body);
  }

  private handlePayload(payload: DiscordPayload): void {
    if (payload.s) {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 10: // HELLO
        this.startHeartbeat((payload.d as { heartbeat_interval: number }).heartbeat_interval);
        this.identify();
        break;

      case 11: // HEARTBEAT_ACK
        // Heartbeat acknowledged
        break;

      case 0: // DISPATCH
        this.handleEvent(payload.t!, payload.d);
        break;

      case 1: // HEARTBEAT request
        this.sendHeartbeat();
        break;

      case 7: // RECONNECT
        this.ws?.close();
        break;

      case 9: // INVALID_SESSION
        // Wait and re-identify
        setTimeout(() => this.identify(), 5000);
        break;
    }
  }

  private handleEvent(event: string, data: unknown): void {
    switch (event) {
      case 'READY':
        this.sessionId = (data as { session_id: string }).session_id;
        break;

      case 'MESSAGE_CREATE':
        this.handleMessage(data as DiscordMessage);
        break;
    }
  }

  private handleMessage(msg: DiscordMessage): void {
    // Ignore bot messages
    if (msg.author.bot) {
      return;
    }

    // Check allowed guilds
    if (msg.guild_id && this.allowedGuildIds.size > 0) {
      if (!this.allowedGuildIds.has(msg.guild_id)) {
        return;
      }
    }

    // Check allowed channels
    if (this.allowedChannelIds.size > 0) {
      if (!this.allowedChannelIds.has(msg.channel_id)) {
        return;
      }
    }

    const attachments: Attachment[] = (msg.attachments ?? []).map(a => ({
      type: this.getAttachmentType(a.content_type),
      filename: a.filename,
      url: a.url,
      mimeType: a.content_type ?? 'application/octet-stream',
      size: a.size,
    }));

    const incoming: IncomingMessage = {
      id: msg.id,
      channel: this.id,
      conversationId: msg.channel_id,
      senderId: msg.author.id,
      senderName: `${msg.author.username}#${msg.author.discriminator}`,
      content: msg.content,
      timestamp: msg.timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: msg,
    };

    this.emitMessage(incoming);
  }

  private getAttachmentType(
    mimeType?: string
  ): 'image' | 'audio' | 'video' | 'file' {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }

  private identify(): void {
    this.ws?.send(
      JSON.stringify({
        op: 2, // IDENTIFY
        d: {
          token: this.botToken,
          intents: 513, // GUILDS + GUILD_MESSAGES
          properties: {
            os: 'linux',
            browser: 'openrappter',
            device: 'openrappter',
          },
        },
      })
    );
  }

  private startHeartbeat(interval: number): void {
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }

  private sendHeartbeat(): void {
    this.ws?.send(
      JSON.stringify({
        op: 1, // HEARTBEAT
        d: this.sequence,
      })
    );
  }

  private async callApi(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status}`);
    }

    return response.json();
  }
}

/**
 * Create a Discord channel
 */
export function createDiscordChannel(
  id: string,
  name: string,
  config: DiscordConfig
): DiscordChannel {
  return new DiscordChannel(id, name, config);
}
