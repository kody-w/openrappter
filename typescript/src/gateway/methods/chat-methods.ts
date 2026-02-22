/**
 * Chat-related RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ChatAbortParams {
  runId: string;
}

interface ChatInjectParams {
  sessionId: string;
  content: string;
  role?: 'system' | 'user' | 'assistant';
}

export interface ChatMessage {
  messageId: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
}

export interface ChatMethodsDeps {
  abortControllers?: Map<string, AbortController>;
  sessionStore?: Map<string, ChatSession>;
}

export function registerChatMethods(server: MethodRegistrar, deps?: ChatMethodsDeps): void {
  const abortControllers = deps?.abortControllers ?? new Map<string, AbortController>();
  const sessionStore = deps?.sessionStore ?? new Map<string, ChatSession>();

  // Abort a running chat execution
  server.registerMethod<ChatAbortParams, { status: string; runId: string }>(
    'chat.abort',
    async (params) => {
      const { runId } = params;

      const controller = abortControllers.get(runId);
      if (!controller) {
        return { status: 'not_found', runId };
      }

      controller.abort();
      abortControllers.delete(runId);

      return { status: 'aborted', runId };
    }
  );

  // Inject a message into a session
  server.registerMethod<ChatInjectParams, { status: string; messageId: string; sessionId: string }>(
    'chat.inject',
    async (params) => {
      const { sessionId, content, role = 'system' } = params;

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      let session = sessionStore.get(sessionId);
      if (!session) {
        session = { id: sessionId, messages: [] };
        sessionStore.set(sessionId, session);
      }

      session.messages.push({
        messageId,
        role,
        content,
        timestamp: Date.now(),
      });

      return {
        status: 'ok',
        messageId,
        sessionId,
      };
    }
  );
}
