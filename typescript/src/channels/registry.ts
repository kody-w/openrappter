/**
 * Channel registry - manages channel instances
 */

import type { BaseChannel } from './base.js';

export interface ChannelStatusInfo {
  id: string;
  type: string;
  connected: boolean;
  configured: boolean;
  running: boolean;
  lastActivity?: string;
  lastConnectedAt?: string;
  lastError?: string;
  messageCount: number;
}

export class ChannelRegistry {
  private channels: Map<string, BaseChannel> = new Map();

  register(channel: BaseChannel): void {
    this.channels.set(channel.name, channel);
  }

  unregister(name: string): boolean {
    return this.channels.delete(name);
  }

  get(name: string): BaseChannel | undefined {
    return this.channels.get(name);
  }

  has(name: string): boolean {
    return this.channels.has(name);
  }

  list(): BaseChannel[] {
    return Array.from(this.channels.values());
  }

  names(): string[] {
    return Array.from(this.channels.keys());
  }

  async connectAll(): Promise<void> {
    const promises = this.list().map(ch => ch.connect());
    await Promise.all(promises);
  }

  async disconnectAll(): Promise<void> {
    const promises = this.list().map(ch => ch.disconnect());
    await Promise.all(promises);
  }

  async connectChannel(type: string): Promise<void> {
    const ch = this.findByType(type);
    if (!ch) throw new Error(`Channel ${type} not registered`);
    await ch.connect();
  }

  async disconnectChannel(type: string): Promise<void> {
    const ch = this.findByType(type);
    if (!ch) throw new Error(`Channel ${type} not registered`);
    await ch.disconnect();
  }

  async probeChannel(type: string): Promise<{ ok: boolean; error?: string }> {
    const ch = this.findByType(type);
    if (!ch) return { ok: false, error: `Channel ${type} not registered` };
    return { ok: ch.connected, error: ch.connected ? undefined : 'Not connected' };
  }

  configureChannel(type: string, config: Record<string, unknown>): void {
    const ch = this.findByType(type);
    if (!ch) throw new Error(`Channel ${type} not registered`);
    ch.setConfig(config);
  }

  getChannelConfig(type: string): { config: Record<string, unknown>; fields: { key: string; label: string; type: string; required: boolean }[] } {
    const ch = this.findByType(type);
    if (!ch) throw new Error(`Channel ${type} not registered`);
    return { config: ch.getConfig(), fields: ch.getConfigFields() };
  }

  async sendMessage(request: { channelId: string; conversationId: string; content: string }): Promise<void> {
    const ch = this.findByType(request.channelId) ?? this.get(request.channelId);
    if (!ch) throw new Error(`Channel ${request.channelId} not found`);
    await ch.send(request.conversationId, {
      channel: request.channelId,
      content: request.content,
    });
  }

  getStatusList(): ChannelStatusInfo[] {
    return this.list().map(ch => {
      const info = ch.getInfo();
      return {
        id: info.name,
        type: info.type,
        connected: info.status === 'connected',
        configured: true,
        running: info.status === 'connected' || info.status === 'connecting',
        lastActivity: info.connectedAt,
        lastConnectedAt: info.connectedAt,
        messageCount: info.messageCount,
      };
    });
  }

  private findByType(type: string): BaseChannel | undefined {
    for (const ch of this.channels.values()) {
      if (ch.type === type || ch.name === type) return ch;
    }
    return undefined;
  }

  clear(): void {
    this.channels.clear();
  }

  get size(): number {
    return this.channels.size;
  }
}
