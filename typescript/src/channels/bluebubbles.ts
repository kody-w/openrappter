import { BaseChannel } from './base.js';
import type { OutgoingMessage } from './types.js';

export class BlueBubblesChannel extends BaseChannel {
  constructor(_config?: Record<string, unknown>) {
    super('bluebubbles', 'bluebubbles');
  }

  async connect(): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/bluebubbles plugin');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(_messageOrId: OutgoingMessage | string, _message?: OutgoingMessage): Promise<void> {
    throw new Error('Not yet implemented — install the @openrappter/bluebubbles plugin');
  }
}
