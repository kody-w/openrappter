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

export function registerChatMethods(server: MethodRegistrar): void {
  // Abort a running chat execution
  server.registerMethod<ChatAbortParams, { success: boolean }>(
    'chat.abort',
    async (params) => {
      const { runId } = params;

      // TODO: Implement abort logic with abort controller map
      // For now, just acknowledge the request
      console.log(`[chat.abort] Received abort request for run: ${runId}`);

      return { success: true };
    }
  );

  // Inject a message into a session
  server.registerMethod<ChatInjectParams, { success: boolean; messageId: string }>(
    'chat.inject',
    async (params) => {
      const { sessionId, content, role = 'system' } = params;

      // TODO: Integrate with session store
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      console.log(`[chat.inject] Injecting ${role} message into session: ${sessionId}`);

      return {
        success: true,
        messageId,
      };
    }
  );
}
