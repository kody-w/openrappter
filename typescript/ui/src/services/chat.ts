/**
 * Chat controller — manages chat session state and sends messages via the
 * gateway's `agent` (synchronous) and `chat.*` (session/history) RPC
 * methods. Session identifiers are sent as both `sessionId` (canonical)
 * and `sessionKey` (legacy/native-client alias) so either-named server
 * handler accepts them — mirrors `resolveSessionId()` in
 * `typescript/src/gateway/server.ts`.
 */
import type { GatewayClient, StreamFrame } from './gateway.js';
import type { AgentResponse, ChatMessage, ChatSessionSummary } from '../types.js';

export const AGENT_REQUEST_TIMEOUT_MS = 15 * 60_000;
export const AGENT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const AGENT_STREAM_OVERALL_TIMEOUT_MS = 30 * 60_000;

export interface ChatState {
  client: GatewayClient | null;
  messages: ChatMessage[];
  sessionId: string | null;
  sending: boolean;
  streaming: boolean;
  streamContent: string;
  error: string | null;
}

export function createChatState(): ChatState {
  return {
    client: null,
    messages: [],
    sessionId: null,
    sending: false,
    streaming: false,
    streamContent: '',
    error: null,
  };
}

function sessionParams(sessionId: string | null | undefined): Record<string, unknown> {
  return sessionId ? { sessionId, sessionKey: sessionId } : {};
}

export async function loadChatHistory(
  state: ChatState,
  sessionId: string,
  limit = 200,
): Promise<void> {
  if (!state.client?.isConnected) return;
  state.error = null;
  try {
    state.messages = await state.client.call<ChatMessage[]>('chat.messages', {
      ...sessionParams(sessionId),
      limit,
    });
    state.sessionId = sessionId;
  } catch (err) {
    state.error = String(err);
  }
}

export async function loadSessions(
  client: GatewayClient,
): Promise<ChatSessionSummary[]> {
  if (!client.isConnected) return [];
  return client.call<ChatSessionSummary[]>('chat.list');
}

export async function deleteSession(
  client: GatewayClient,
  sessionId: string,
): Promise<boolean> {
  if (!client.isConnected) return false;
  const res = await client.call<{ deleted: boolean }>('chat.delete', sessionParams(sessionId));
  return res.deleted;
}

/** Send a message and await the final (non-streaming) response via the
 * gateway's synchronous `agent` method. */
export async function sendChatMessage(
  state: ChatState,
  message: string,
  options?: { agentId?: string; signal?: AbortSignal },
): Promise<AgentResponse | null> {
  const trimmed = message.trim();
  if (!trimmed || !state.client) return null;

  state.sending = true;
  state.streaming = false;
  state.error = null;

  try {
    const result = await state.client.call<AgentResponse>('agent', {
      agentId: options?.agentId,
      message: trimmed,
      ...sessionParams(state.sessionId),
    }, {
      timeoutMs: AGENT_REQUEST_TIMEOUT_MS,
      signal: options?.signal,
    });
    state.sessionId = result.sessionId;
    const now = new Date().toISOString();
    state.messages = [
      ...state.messages,
      { id: `local_${Date.now()}_u`, role: 'user', content: trimmed, timestamp: now },
      { id: `local_${Date.now()}_a`, role: 'assistant', content: result.content, timestamp: now },
    ];
    return result;
  } catch (err) {
    state.error = String(err);
    return null;
  } finally {
    state.sending = false;
    state.streaming = false;
  }
}

/** Send a message using the streaming variant of `agent`, accumulating
 * chunks into `state.streamContent` as they arrive. Resolves with the
 * final `AgentResponse` once the server marks the stream `done`. */
export async function sendChatMessageStreaming(
  state: ChatState,
  message: string,
  options?: { agentId?: string; signal?: AbortSignal },
): Promise<AgentResponse | null> {
  const trimmed = message.trim();
  if (!trimmed || !state.client) return null;

  state.sending = true;
  state.streaming = true;
  state.streamContent = '';
  state.error = null;

  try {
    const result = await state.client.callStream<AgentResponse>(
      'agent',
      {
        agentId: options?.agentId,
        message: trimmed,
        ...sessionParams(state.sessionId),
      },
      (frame: StreamFrame) => {
        if (frame.chunk) state.streamContent += frame.chunk;
      },
      {
        idleTimeoutMs: AGENT_STREAM_IDLE_TIMEOUT_MS,
        overallTimeoutMs: AGENT_STREAM_OVERALL_TIMEOUT_MS,
        signal: options?.signal,
      },
    );
    if (result?.sessionId) state.sessionId = result.sessionId;
    return result ?? null;
  } catch (err) {
    state.error = String(err);
    return null;
  } finally {
    state.sending = false;
    state.streaming = false;
  }
}
