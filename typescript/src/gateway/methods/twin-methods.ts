/**
 * Digital Twin messaging RPC methods.
 *
 * Real-time encrypted messaging with iMessage sync.
 * The twin is the source of truth — iMessage is the delivery layer.
 */

import { EncryptedMessageStore } from '../../messaging/store.js';
import type { TwinMessage } from '../../messaging/store.js';
import { PIIStripper, PIIVault } from '../../messaging/pii.js';
import { EdgePublisher, signBlob, verifyBlob } from '../../messaging/edge-sync.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
  broadcast?(event: string, data: unknown): void;
}

/** Shared instances — initialized once, used by all methods */
let store: EncryptedMessageStore | null = null;
let piiStripper: PIIStripper | null = null;
let piiVault: PIIVault | null = null;

export function getOrCreateStore(): EncryptedMessageStore {
  if (!store) store = new EncryptedMessageStore();
  return store;
}

export function getOrCreatePII(): { stripper: PIIStripper; vault: PIIVault } {
  if (!piiStripper) piiStripper = new PIIStripper();
  if (!piiVault) piiVault = new PIIVault();
  return { stripper: piiStripper, vault: piiVault };
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
    const { stripper, vault } = getOrCreatePII();

    // Add sender as known name for PII stripping
    if (params.sender) stripper.addKnownNames([params.sender]);

    // Strip PII before encryption — PII map stays local only
    const { stripped, piiMap, piiCount } = stripper.strip(params.content);

    const msg = twinStore.addMessage(params.conversationId, {
      sender: params.sender,
      senderEmoji: params.senderEmoji,
      content: stripped, // PII-stripped content gets encrypted
      status: 'instant',
      metadata: piiCount > 0 ? { piiStripped: true, piiCount } : undefined,
    });

    // Store PII map locally (NEVER transmitted)
    if (piiCount > 0) {
      vault.store(msg.id, params.conversationId, piiMap);
    }

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
  server.registerMethod<{ conversationId: string; limit?: number; after?: string; reattachPII?: boolean }>(
    'twin.history',
    async (params) => {
      const messages = twinStore.getMessages(params.conversationId, {
        limit: params.limit,
        after: params.after,
      });

      // Reattach PII from local vault if requested (client-side operation)
      if (params.reattachPII !== false) {
        const { stripper, vault } = getOrCreatePII();
        for (const msg of messages) {
          const localPII = vault.get(msg.id);
          if (localPII) {
            msg.content = stripper.reattach(msg.content, localPII);
          }
        }
      }

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

  /**
   * Publish a conversation as signed static files for edge sync
   */
  server.registerMethod<{ conversationId: string; outputDir?: string }>(
    'edge.publish',
    async (params) => {
      const key = twinStore.getKey(params.conversationId);
      if (!key) throw new Error(`Conversation not found: ${params.conversationId}`);

      const exported = twinStore.export(params.conversationId);
      const outputDir = params.outputDir || '/tmp/rappsignal-edge';
      const publisher = new EdgePublisher({ outputDir });
      const channelFile = publisher.publish(exported, key);
      const manifest = publisher.generateManifest([channelFile]);
      const files = await publisher.writeFiles(channelFile, manifest);

      return {
        status: 'published',
        conversationId: params.conversationId,
        messageCount: channelFile.messages.length,
        headHash: channelFile.channel.headHash,
        files,
      };
    }
  );

  /**
   * Get edge sync status for a conversation
   */
  server.registerMethod<{ conversationId: string }>(
    'edge.status',
    async (params) => {
      const key = twinStore.getKey(params.conversationId);
      if (!key) throw new Error(`Conversation not found: ${params.conversationId}`);

      const convo = twinStore.getConversation(params.conversationId);
      return {
        conversationId: params.conversationId,
        name: convo?.name,
        messageCount: convo?.messageCount || 0,
        hasKey: true,
        edgeReady: true,
      };
    }
  );
}
