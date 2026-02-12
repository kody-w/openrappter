import { BaseChannel } from './base.js';
import type { OutgoingMessage } from './types.js';

export class FeishuChannel extends BaseChannel {
  constructor(config?: Record<string, unknown>) {
    super('feishu', 'feishu');
  }

  async connect(): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/feishu plugin');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(messageOrId: OutgoingMessage | string, message?: OutgoingMessage): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/feishu plugin');
  }
}
