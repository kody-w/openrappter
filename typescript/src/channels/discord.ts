/**
 * Discord channel implementation using Discord Gateway WebSocket
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

export class DiscordChannel extends BaseChannel {
  private botToken: string;
  private allowedGuildIds: Set<string>;
  private allowedChannelIds: Set<string>;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private baseUrl = 'https://discord.com/api/v10';
  private gatewayUrl = 'wss://gateway.discord.gg/?v=10&encoding=json';

  constructor(config: DiscordConfig);
  constructor(id: string, name: string, config: DiscordConfig);
  constructor(idOrConfig: string | DiscordConfig, name?: string, config?: DiscordConfig) {
    if (typeof idOrConfig === 'string') {
      super(name ?? idOrConfig, 'discord');
      this.botToken = config!.botToken;
      this.allowedGuildIds = new Set(config!.allowedGuildIds ?? []);
      this.allowedChannelIds = new Set(config!.allowedChannelIds ?? []);
    } else {
      super('discord', 'discord');
      this.botToken = idOrConfig.botToken;
      this.allowedGuildIds = new Set(idOrConfig.allowedGuildIds ?? []);
      this.allowedChannelIds = new Set(idOrConfig.allowedChannelIds ?? []);
    }
  }

  override getConfigFields() {
    return [
      { key: 'botToken', label: 'Bot Token', type: 'password' as const, required: true },
    ];
  }

  override setConfig(config: Record<string, unknown>): void {
    if (config.botToken !== undefined) this.botToken = config.botToken as string;
  }

  override getConfig(): Record<string, unknown> {
    const t = this.botToken;
    return { botToken: t.length > 4 ? t.slice(0, 4) + '•'.repeat(Math.min(t.length - 4, 20)) : t };
  }

  async connect(): Promise<void> {
    this.status = 'connecting';

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.gatewayUrl);

      this.ws.on('message', (data) => {
        const payload = JSON.parse(data.toString()) as DiscordPayload;
        this.handlePayload(payload);

        if (payload.op === 10) {
          this.status = 'connected';
          this.connectedAt = new Date().toISOString();
          resolve();
        }
      });

      this.ws.on('error', (error) => {
        this.status = 'error';
        reject(error);
      });

      this.ws.on('close', () => {
        if (this.connected) {
          setTimeout(() => this.connect().catch(() => {}), 5000);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
  }

  async send(messageOrId: OutgoingMessage | string, message?: OutgoingMessage): Promise<void> {
    const msg = typeof messageOrId === 'string' ? message! : messageOrId;
    const channelId = typeof messageOrId === 'string' ? messageOrId : msg.recipient;

    const body: Record<string, unknown> = {
      content: msg.content,
    };

    if (msg.replyTo) {
      body.message_reference = { message_id: msg.replyTo };
    }

    if (msg.attachments?.length) {
      const embeds = msg.attachments
        .filter(a => a.url)
        .map(a => ({
          image: a.type === 'image' ? { url: a.url } : undefined,
          title: a.name ?? a.filename,
        }));

      if (embeds.length > 0) {
        body.embeds = embeds;
      }
    }

    await this.callApi('POST', `/channels/${channelId}/messages`, body);
    this.messageCount++;
  }

  private handlePayload(payload: DiscordPayload): void {
    if (payload.s) this.sequence = payload.s;

    switch (payload.op) {
      case 10: // HELLO
        this.startHeartbeat((payload.d as { heartbeat_interval: number }).heartbeat_interval);
        this.identify();
        break;
      case 11: // HEARTBEAT_ACK
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
    if (msg.author.bot) return;

    if (msg.guild_id && this.allowedGuildIds.size > 0) {
      if (!this.allowedGuildIds.has(msg.guild_id)) return;
    }

    if (this.allowedChannelIds.size > 0) {
      if (!this.allowedChannelIds.has(msg.channel_id)) return;
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
      channel: 'discord',
      sender: msg.author.id,
      senderName: msg.author.username,
      content: msg.content,
      timestamp: msg.timestamp,
      conversationId: msg.channel_id,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: msg,
    };

    this.emitMessage(incoming);
  }

  private getAttachmentType(mimeType?: string): 'image' | 'audio' | 'video' | 'file' {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'file';
  }

  private identify(): void {
    this.ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: this.botToken,
        intents: 513, // GUILDS + GUILD_MESSAGES
        properties: { os: 'linux', browser: 'openrappter', device: 'openrappter' },
      },
    }));
  }

  private startHeartbeat(interval: number): void {
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), interval);
  }

  private sendHeartbeat(): void {
    this.ws?.send(JSON.stringify({ op: 1, d: this.sequence }));
  }

  private async callApi(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
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

export function createDiscordChannel(config: DiscordConfig): DiscordChannel;
export function createDiscordChannel(id: string, name: string, config: DiscordConfig): DiscordChannel;
export function createDiscordChannel(idOrConfig: string | DiscordConfig, name?: string, config?: DiscordConfig): DiscordChannel {
  if (typeof idOrConfig === 'string') {
    return new DiscordChannel(idOrConfig, name!, config!);
  }
  return new DiscordChannel(idOrConfig);
}
