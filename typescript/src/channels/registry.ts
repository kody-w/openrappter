/**
 * Channel registry - manages channel instances
 */

import type { BaseChannel } from './base.js';

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

  clear(): void {
    this.channels.clear();
  }

  get size(): number {
    return this.channels.size;
  }
}
