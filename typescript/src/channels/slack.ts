/**
 * Slack channel implementation using Slack Web API and Socket Mode
 */

import { BaseChannel } from './base.js';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
} from './types.js';
import { WebSocket } from 'ws';

export interface SlackConfig extends ChannelConfig {
  botToken: string;       // xoxb-...
  appToken: string;       // xapp-... (for Socket Mode)
  allowedChannelIds?: string[];
}

interface SlackMessage {
  type: 'message';
  subtype?: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    url_private: string;
    size: number;
  }>;
}

interface SlackSocketEvent {
  type: string;
  envelope_id?: string;
  payload?: {
    event?: SlackMessage;
  };
}

interface SlackApiResponse {
  ok: boolean;
  user_id?: string;
  url?: string;
  user?: {
    real_name?: string;
    name: string;
  };
  [key: string]: unknown;
}

/**
 * Slack Bot Channel
 */
export class SlackChannel extends BaseChannel {
  id: string;
  name: string;

  private botToken: string;
  private appToken: string;
  private allowedChannelIds: Set<string>;
  private ws: WebSocket | null = null;
  private baseUrl = 'https://slack.com/api';
  private userCache = new Map<string, string>();
  private botUserId: string | null = null;

  constructor(id: string, name: string, config: SlackConfig) {
    super(name, 'slack');
    this.id = id;
    this.name = name;
    this.botToken = config.botToken;
    this.appToken = config.appToken;
    this.allowedChannelIds = new Set(config.allowedChannelIds ?? []);
  }

  async connect(): Promise<void> {
    // Get bot user ID
    const auth = await this.callApi('auth.test') as SlackApiResponse;
    if (!auth.ok) {
      throw new Error('Invalid Slack bot token');
    }
    this.botUserId = auth.user_id ?? null;

    // Connect to Socket Mode
    const conn = await this.callApi('apps.connections.open', {}, this.appToken) as SlackApiResponse;
    if (!conn.ok || !conn.url) {
      throw new Error('Failed to open Socket Mode connection');
    }

    await this.connectSocket(conn.url);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.ws) {
      this.ws.close(1000, 'Shutting down');
      this.ws = null;
    }
  }

  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    const body: Record<string, unknown> = {
      channel: conversationId,
      text: message.content,
    };

    if (message.replyTo) {
      body.thread_ts = message.replyTo;
    }

    // Handle attachments
    if (message.attachments?.length) {
      const blocks = message.attachments
        .filter(a => a.url)
        .map(a => ({
          type: 'image',
          image_url: a.url,
          alt_text: a.filename ?? 'attachment',
        }));

      if (blocks.length > 0) {
        body.blocks = [
          { type: 'section', text: { type: 'mrkdwn', text: message.content } },
          ...blocks,
        ];
      }
    }

    await this.callApi('chat.postMessage', body);
  }

  private async connectSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('message', (data) => {
        const event = JSON.parse(data.toString()) as SlackSocketEvent;
        this.handleEvent(event);
      });

      this.ws.on('error', (error) => {
        reject(error);
      });

      this.ws.on('close', async () => {
        if (this.connected) {
          // Reconnect
          setTimeout(async () => {
            try {
              const conn = await this.callApi('apps.connections.open', {}, this.appToken) as SlackApiResponse;
              if (conn.ok && conn.url) {
                await this.connectSocket(conn.url);
              }
            } catch {
              // Retry later
            }
          }, 5000);
        }
      });
    });
  }

  private handleEvent(event: SlackSocketEvent): void {
    // Acknowledge the event
    if (event.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: event.envelope_id }));
    }

    if (event.type === 'events_api' && event.payload?.event) {
      const msg = event.payload.event;

      if (msg.type === 'message' && !msg.subtype) {
        this.handleMessage(msg);
      }
    }
  }

  private async handleMessage(msg: SlackMessage): Promise<void> {
    // Ignore bot's own messages
    if (msg.user === this.botUserId) {
      return;
    }

    // Check allowed channels
    if (this.allowedChannelIds.size > 0) {
      if (!this.allowedChannelIds.has(msg.channel)) {
        return;
      }
    }

    // Get user name
    const senderName = await this.getUserName(msg.user);

    const attachments: Attachment[] = (msg.files ?? []).map(f => ({
      type: this.getAttachmentType(f.mimetype),
      filename: f.name,
      url: f.url_private,
      mimeType: f.mimetype,
      size: f.size,
    }));

    const incoming: IncomingMessage = {
      id: msg.ts,
      channel: this.id,
      conversationId: msg.channel,
      senderId: msg.user,
      senderName,
      content: msg.text,
      timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      replyTo: msg.thread_ts,
      attachments: attachments.length > 0 ? attachments : undefined,
      raw: msg,
    };

    await this.emitMessage(incoming);
  }

  private async getUserName(userId: string): Promise<string> {
    // Check cache
    const cached = this.userCache.get(userId);
    if (cached) {
      return cached;
    }

    try {
      const result = await this.callApi('users.info', { user: userId }) as SlackApiResponse;
      if (result.ok && result.user) {
        const name = result.user.real_name ?? result.user.name;
        this.userCache.set(userId, name);
        return name;
      }
    } catch {
      // Fall through
    }

    return userId;
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

  private async callApi(
    method: string,
    params: Record<string, unknown> = {},
    token?: string
  ): Promise<SlackApiResponse> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token ?? this.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    return response.json() as Promise<SlackApiResponse>;
  }
}

/**
 * Create a Slack channel
 */
export function createSlackChannel(
  id: string,
  name: string,
  config: SlackConfig
): SlackChannel {
  return new SlackChannel(id, name, config);
}
