/**
 * Base channel class - all channels extend this
 */

import type { IncomingMessage, OutgoingMessage, ChannelStatus, ChannelInfo, MessageHandler } from './types.js';

export abstract class BaseChannel {
  readonly name: string;
  readonly type: string;
  protected status: ChannelStatus = 'disconnected';
  protected connectedAt?: string;
  protected messageCount = 0;
  protected handlers: MessageHandler[] = [];

  constructor(name?: string, type?: string) {
    this.name = name ?? '';
    this.type = type ?? '';
  }

  get connected(): boolean {
    return this.status === 'connected';
  }

  set connected(value: boolean) {
    this.status = value ? 'connected' : 'disconnected';
    if (value && !this.connectedAt) {
      this.connectedAt = new Date().toISOString();
    }
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  /** Update channel config at runtime (e.g., setting API tokens from the UI) */
  setConfig(config: Record<string, unknown>): void {
    const self = this as unknown as { config: Record<string, unknown> };
    if (self.config && typeof self.config === 'object') {
      Object.assign(self.config, config);
    }
  }

  /** Return current config (redacts tokens for display) */
  getConfig(): Record<string, unknown> {
    const self = this as unknown as { config?: Record<string, unknown> };
    if (!self.config) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(self.config)) {
      if (typeof v === 'string' && /token|secret|key|password/i.test(k) && v.length > 4) {
        out[k] = v.slice(0, 4) + '•'.repeat(Math.min(v.length - 4, 20));
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** Return config field definitions for UI rendering */
  getConfigFields(): { key: string; label: string; type: 'text' | 'password'; required: boolean }[] {
    return [];
  }
  abstract send(conversationId: string, message: OutgoingMessage): Promise<void>;

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  protected async emitMessage(message: IncomingMessage): Promise<void> {
    this.messageCount++;
    for (const handler of this.handlers) {
      await handler(message);
    }
  }

  getStatus(): ChannelStatus {
    return this.status;
  }

  getInfo(): ChannelInfo {
    return {
      name: this.name,
      type: this.type,
      status: this.status,
      connectedAt: this.connectedAt,
      messageCount: this.messageCount,
    };
  }

  async sendTyping(_conversationId: string): Promise<void> {
    // No-op default — channels override if supported
  }

  async react(_conversationId: string, _messageId: string, _emoji: string): Promise<void> {
    // No-op default
  }

  async removeReaction(_conversationId: string, _messageId: string, _emoji: string): Promise<void> {
    // No-op default
  }

  async replyInThread(_threadId: string, message: OutgoingMessage): Promise<void> {
    return this.send(_threadId, message);
  }
}
