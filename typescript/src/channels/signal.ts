/**
 * Signal Channel
 * Uses signal-cli for Signal messaging
 */

import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import type {
  IncomingMessage,
  OutgoingMessage,
  ChannelConfig,
  Attachment,
  Conversation,
} from './types.js';

export interface SignalConfig extends ChannelConfig {
  phoneNumber: string;
  signalCliPath?: string;
  configPath?: string;
}

interface SignalMessage {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp?: number;
    dataMessage?: {
      message?: string;
      groupInfo?: {
        groupId: string;
        groupName?: string;
      };
      attachments?: Array<{
        contentType: string;
        filename?: string;
        id: string;
      }>;
    };
  };
}

export class SignalChannel extends EventEmitter {
  private config: SignalConfig;
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private isConnected = false;

  constructor(config: SignalConfig) {
    super();
    this.config = {
      enabled: true,
      signalCliPath: 'signal-cli',
      ...config,
    };
  }

  get id(): string {
    return 'signal';
  }

  get type(): string {
    return 'signal';
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /**
   * Connect to Signal via signal-cli
   */
  async connect(): Promise<void> {
    if (this.process) return;

    const args = ['--output=json', '-u', this.config.phoneNumber, 'receive', '--timeout', '-1'];

    if (this.config.configPath) {
      args.unshift('--config', this.config.configPath);
    }

    this.process = spawn(this.config.signalCliPath!, args);

    this.readline = createInterface({
      input: this.process.stdout!,
    });

    this.readline.on('line', (line) => {
      try {
        const data = JSON.parse(line) as SignalMessage;
        this.handleIncomingMessage(data);
      } catch {
        // Ignore non-JSON output
      }
    });

    this.process.stderr?.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Envelope')) return; // Ignore envelope debug messages
      console.error('Signal error:', msg);
    });

    this.process.on('close', (code) => {
      console.log(`Signal process exited with code ${code}`);
      this.isConnected = false;
      this.emit('disconnected');
    });

    this.process.on('error', (error) => {
      console.error('Signal process error:', error);
      this.emit('error', error);
    });

    this.isConnected = true;
    console.log(`Signal connected as ${this.config.phoneNumber}`);
    this.emit('connected');
  }

  /**
   * Disconnect from Signal
   */
  async disconnect(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.isConnected = false;
  }

  /**
   * Send a message
   */
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    const args = ['--output=json', '-u', this.config.phoneNumber];

    if (this.config.configPath) {
      args.unshift('--config', this.config.configPath);
    }

    // Determine if group or direct message
    const isGroup = conversationId.startsWith('group:');
    if (isGroup) {
      args.push('send', '-g', conversationId.replace('group:', ''));
    } else {
      args.push('send', conversationId);
    }

    args.push('-m', message.content);

    // Add attachments
    if (message.attachments) {
      for (const attachment of message.attachments) {
        if (attachment.url) {
          args.push('-a', attachment.url);
        }
      }
    }

    return new Promise((resolve, reject) => {
      const sendProcess = spawn(this.config.signalCliPath!, args);

      let stderr = '';
      sendProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      sendProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Signal send failed: ${stderr}`));
        }
      });

      sendProcess.on('error', reject);
    });
  }

  /**
   * Set message handler
   */
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Handle incoming message
   */
  private handleIncomingMessage(data: SignalMessage): void {
    if (!this.messageHandler) return;
    if (!data.envelope?.dataMessage?.message) return;

    const envelope = data.envelope;
    const dataMessage = envelope.dataMessage!;
    const isGroup = !!dataMessage.groupInfo;

    const incoming: IncomingMessage = {
      id: `signal_${envelope.timestamp}`,
      channel: 'signal',
      conversationId: isGroup
        ? `group:${dataMessage.groupInfo!.groupId}`
        : envelope.sourceNumber ?? envelope.source ?? '',
      senderId: envelope.sourceNumber ?? envelope.source ?? '',
      content: dataMessage.message!,
      timestamp: new Date((envelope.timestamp ?? Date.now()) / 1000).toISOString(),
      attachments: this.extractAttachments(dataMessage.attachments),
      metadata: {
        isGroup,
        groupName: dataMessage.groupInfo?.groupName,
        sourceName: envelope.sourceName,
      },
    };

    this.messageHandler(incoming);
  }

  /**
   * Extract attachments
   */
  private extractAttachments(
    attachments?: Array<{ contentType: string; filename?: string; id: string }>
  ): Attachment[] {
    if (!attachments) return [];

    return attachments.map((att) => ({
      type: this.getAttachmentType(att.contentType),
      mimeType: att.contentType,
      filename: att.filename,
      // Note: Actual attachment content would need to be fetched separately
    }));
  }

  /**
   * Get attachment type from MIME type
   */
  private getAttachmentType(mimeType: string): Attachment['type'] {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Get conversation info
   */
  async getConversation(conversationId: string): Promise<Conversation | null> {
    const isGroup = conversationId.startsWith('group:');

    return {
      id: conversationId,
      name: isGroup ? conversationId.replace('group:', '') : conversationId,
      type: isGroup ? 'group' : 'dm',
      participants: [],
    };
  }

  /**
   * Link device (for first-time setup)
   */
  async linkDevice(): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['link', '-n', 'OpenRappter'];

      if (this.config.configPath) {
        args.unshift('--config', this.config.configPath);
      }

      const linkProcess = spawn(this.config.signalCliPath!, args);

      let output = '';
      linkProcess.stdout?.on('data', (data) => {
        output += data.toString();
        // Look for tsdevice link
        const match = output.match(/tsdevice:\S+/);
        if (match) {
          resolve(match[0]);
        }
      });

      linkProcess.stderr?.on('data', (data) => {
        console.error('Signal link error:', data.toString());
      });

      linkProcess.on('close', (code) => {
        if (code !== 0 && !output.includes('tsdevice:')) {
          reject(new Error('Failed to link device'));
        }
      });

      linkProcess.on('error', reject);
    });
  }

  /**
   * Register phone number (for primary device setup)
   */
  async register(captcha?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['register', this.config.phoneNumber];

      if (this.config.configPath) {
        args.unshift('--config', this.config.configPath);
      }

      if (captcha) {
        args.push('--captcha', captcha);
      }

      const registerProcess = spawn(this.config.signalCliPath!, args);

      let stderr = '';
      registerProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      registerProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Signal registration failed: ${stderr}`));
        }
      });

      registerProcess.on('error', reject);
    });
  }

  /**
   * Verify registration code
   */
  async verify(code: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['verify', this.config.phoneNumber, code];

      if (this.config.configPath) {
        args.unshift('--config', this.config.configPath);
      }

      const verifyProcess = spawn(this.config.signalCliPath!, args);

      let stderr = '';
      verifyProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      verifyProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Signal verification failed: ${stderr}`));
        }
      });

      verifyProcess.on('error', reject);
    });
  }
}

export function createSignalChannel(config: SignalConfig): SignalChannel {
  return new SignalChannel(config);
}
