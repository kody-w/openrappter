/**
 * Digital Twin messaging RPC methods.
 *
 * Real-time encrypted messaging with iMessage sync.
 * The twin is the source of truth — iMessage is the delivery layer.
 */

import { EncryptedMessageStore } from '../../messaging/store.js';
import type { TwinMessage } from '../../messaging/store.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
  broadcast?(event: string, data: unknown): void;
}

/** Shared store instance — initialized once, used by all methods */
let store: EncryptedMessageStore | null = null;

export function getOrCreateStore(): EncryptedMessageStore {
  if (!store) {
    store = new EncryptedMessageStore();
  }
  return store;
}

export function registerTwinMethods(server: MethodRegistrar, deps?: Record<string, unknown>): void {
  const twinStore = getOrCreateStore();
  const imessageSend = deps?.imessageSend as ((recipient: string, content: string) => Promise<void>) | undefined;

  /**
   * List all conversations
   */
  server.registerMethod('twin.conversations', async () => {
    return {
      conversations: twinStore.listConversations().map(c => ({
        id: c.id,
        name: c.name,
        participants: c.participants,
        messageCount: c.messageCount,
        lastMessageAt: c.lastMessageAt,
        createdAt: c.createdAt,
      })),
    };
  });

  /**
   * Create a new encrypted conversation
   */
  server.registerMethod<{ name: string; participants: string[]; key?: string }>(
    'twin.create',
    async (params) => {
      const convo = twinStore.createConversation({
        name: params.name,
        participants: params.participants,
        key: params.key,
      });
      return {
        id: convo.id,
        name: convo.name,
        key: convo.key,
        participants: convo.participants,
      };
    }
  );

  /**
   * Send a message — instant in twin, async iMessage sync
   */
  server.registerMethod<{
    conversationId: string;
    sender: string;
    senderEmoji?: string;
    content: string;
    syncToIMessage?: boolean;
    imessageRecipient?: string;
  }>('twin.send', async (params) => {
    const msg = twinStore.addMessage(params.conversationId, {
      sender: params.sender,
      senderEmoji: params.senderEmoji,
      content: params.content,
      status: 'instant',
    });

    // Broadcast to all WebSocket subscribers
    if (server.broadcast) {
      server.broadcast('twin.message', {
        conversationId: params.conversationId,
        message: msg,
      });
    }

    // Background iMessage sync
    if (params.syncToIMessage && params.imessageRecipient && imessageSend) {
      twinStore.updateStatus(msg.id, params.conversationId, 'syncing');
      if (server.broadcast) {
        server.broadcast('twin.status', { messageId: msg.id, status: 'syncing' });
      }

      // Fire and forget — don't block the response
      imessageSend(params.imessageRecipient, `${params.senderEmoji || ''} ${params.sender}: ${params.content}`)
        .then(() => {
          twinStore.updateStatus(msg.id, params.conversationId, 'delivered');
          if (server.broadcast) {
            server.broadcast('twin.status', { messageId: msg.id, status: 'delivered' });
          }
        })
        .catch(() => {
          twinStore.updateStatus(msg.id, params.conversationId, 'failed');
          if (server.broadcast) {
            server.broadcast('twin.status', { messageId: msg.id, status: 'failed' });
          }
        });
    }

    return msg;
  });

  /**
   * Get message history for a conversation
   */
  server.registerMethod<{ conversationId: string; limit?: number; after?: string }>(
    'twin.history',
    async (params) => {
      const messages = twinStore.getMessages(params.conversationId, {
        limit: params.limit,
        after: params.after,
      });
      return { conversationId: params.conversationId, messages };
    }
  );

  /**
   * Get/rotate conversation key
   */
  server.registerMethod<{ conversationId: string }>(
    'twin.key',
    async (params) => {
      const key = twinStore.getKey(params.conversationId);
      if (!key) throw new Error(`Conversation not found: ${params.conversationId}`);
      return { conversationId: params.conversationId, key };
    }
  );

  /**
   * Generate egg.json for key exchange
   */
  server.registerMethod<{ conversationId: string }>(
    'twin.egg',
    async (params) => {
      return twinStore.generateEgg(params.conversationId);
    }
  );

  /**
   * Export encrypted conversation (safe to publish)
   */
  server.registerMethod<{ conversationId: string }>(
    'twin.export',
    async (params) => {
      return twinStore.export(params.conversationId);
    }
  );

  /**
   * Import encrypted conversation with key
   */
  server.registerMethod<{ data: any; key: string }>(
    'twin.import',
    async (params) => {
      const convo = twinStore.importConversation(params.data, params.key);
      return {
        id: convo.id,
        name: convo.name,
        participants: convo.participants,
        messageCount: convo.messageCount,
      };
    }
  );

  /**
   * Ingest an incoming iMessage into the twin store
   * (called by the iMessage poller, not by clients)
   */
  server.registerMethod<{
    conversationId: string;
    sender: string;
    senderEmoji?: string;
    content: string;
    imessageRowId?: number;
  }>('twin.ingest', async (params) => {
    const msg = twinStore.addMessage(params.conversationId, {
      sender: params.sender,
      senderEmoji: params.senderEmoji,
      content: params.content,
      status: 'delivered', // already delivered via iMessage
      metadata: params.imessageRowId ? { imessageRowId: params.imessageRowId } : undefined,
    });

    if (server.broadcast) {
      server.broadcast('twin.message', {
        conversationId: params.conversationId,
        message: msg,
      });
    }

    return msg;
  });
}
