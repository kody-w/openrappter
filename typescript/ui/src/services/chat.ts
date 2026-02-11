/**
 * Chat controller — sends messages via gateway chat.send method.
 */
import type { GatewayClient } from './gateway.js';
import type { ChatMessage, ChatSessionSummary } from '../types.js';

export async function loadChatHistory(
  client: GatewayClient,
  sessionKey: string,
  limit = 200,
): Promise<ChatMessage[]> {
  if (!client.isConnected) return [];
  return client.request<ChatMessage[]>('chat.messages', { sessionKey, limit });
}

export async function loadSessions(
  client: GatewayClient,
): Promise<ChatSessionSummary[]> {
  if (!client.isConnected) return [];
  return client.request<ChatSessionSummary[]>('chat.list');
}

export async function deleteSession(
  client: GatewayClient,
  sessionKey: string,
): Promise<boolean> {
  if (!client.isConnected) return false;
  const res = await client.request<{ deleted: boolean }>('chat.delete', { sessionKey });
  return res.deleted;
}
