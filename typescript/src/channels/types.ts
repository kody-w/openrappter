/**
 * Channel system types
 */

import type { ThreadContext } from './thread.js';

export interface ChannelConfig {
  enabled?: boolean;
  allowFrom?: string[];
  mentionGating?: boolean;
}

export interface IncomingMessage {
  id: string;
  channel: string;
  sender: string;
  senderName?: string;
  content: string;
  timestamp: string;
  conversationId?: string;
  replyTo?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
  raw?: unknown;
  thread?: ThreadContext;
}

export interface OutgoingMessage {
  channel: string;
  recipient?: string;
  content: string;
  replyTo?: string;
  threadId?: string;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'document' | 'file';
  url?: string;
  path?: string;
  data?: string;
  filename?: string;
  mimeType?: string;
  name?: string;
  size?: number;
}

export interface Conversation {
  id: string;
  name: string;
  type: 'dm' | 'group' | 'channel';
  participants: string[];
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
