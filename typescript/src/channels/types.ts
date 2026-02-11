/**
 * Channel system types
 */

export interface IncomingMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
  replyTo?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface OutgoingMessage {
  channel: string;
  recipient?: string;
  content: string;
  replyTo?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  url?: string;
  path?: string;
  mimeType?: string;
  name?: string;
  size?: number;
}

export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChannelInfo {
  name: string;
  type: string;
  status: ChannelStatus;
  connectedAt?: string;
  messageCount: number;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
