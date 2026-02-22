import { BaseChannel } from './base.js';
import type { OutgoingMessage } from './types.js';

export class NostrChannel extends BaseChannel {
  constructor(_config?: Record<string, unknown>) {
    super('nostr', 'nostr');
  }

  async connect(): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/nostr plugin');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(_messageOrId: OutgoingMessage | string, _message?: OutgoingMessage): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/nostr plugin');
  }
}
