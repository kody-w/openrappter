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

  constructor(name: string, type: string) {
    this.name = name;
    this.type = type;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(message: OutgoingMessage): Promise<void>;

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
}
