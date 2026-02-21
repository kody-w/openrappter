/**
 * Session management RPC methods
 */

import { sanitizeMessages } from '../../providers/messages.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface ChatSession {
  id: string;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
}

interface SessionMethodsDeps {
  sessionStore?: Map<string, ChatSession>;
}

export function registerSessionMethods(
  server: MethodRegistrar,
  deps?: SessionMethodsDeps
): void {
  const store = deps?.sessionStore ?? new Map<string, ChatSession>();

  server.registerMethod<
    { sessionId: string },
    { summary: string; messageCount: number; lastActivity: number }
  >('sessions.preview', async (params) => {
    const session = store.get(params.sessionId);

    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    const messageCount = session.messages.length;
    const lastActivity =
      messageCount > 0
        ? session.messages[messageCount - 1].timestamp
        : Date.now();

    const summary =
      messageCount > 0
        ? session.messages[0].content.slice(0, 100)
        : 'Empty session';

    return { summary, messageCount, lastActivity };
  });

  server.registerMethod<
    { sessionId: string; updates: Record<string, unknown> },
    { success: boolean }
  >('sessions.patch', async (params) => {
    const session = store.get(params.sessionId);

    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    session.metadata = { ...session.metadata, ...params.updates };

    return { success: true };
  });

  server.registerMethod<{ sessionId: string }, { success: boolean; messageCount: number }>(
    'sessions.reset',
    async (params) => {
      const session = store.get(params.sessionId);

      if (!session) {
        throw new Error(`Session not found: ${params.sessionId}`);
      }

      const previousCount = session.messages.length;
      session.messages = [];

      return { success: true, messageCount: previousCount };
    }
  );

  server.registerMethod<
    { sessionId: string; maxMessages?: number },
    { success: boolean; removedCount: number }
  >('sessions.compact', async (params) => {
    const session = store.get(params.sessionId);

    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    const maxMessages = params.maxMessages ?? 50;
    const originalCount = session.messages.length;

    if (originalCount > maxMessages) {
      session.messages = sanitizeMessages(session.messages.slice(-maxMessages));
    }

    return {
      success: true,
      removedCount: originalCount - session.messages.length,
    };
  });
}
