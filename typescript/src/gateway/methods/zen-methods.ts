/**
 * Zen streaming RPC methods — expose PeerStreamManager over gateway.
 *
 * Methods:
 *   zen.sessions        — List active zen streaming sessions
 *   zen.subscribe       — Subscribe to a session (get frames via events)
 *   zen.unsubscribe     — Stop receiving frames
 *   zen.lastFrame       — Get latest frame (for late joiners)
 */

import { globalPeerStream } from '../peer-stream.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

export function registerZenMethods(
  server: MethodRegistrar,
  _deps?: Record<string, unknown>
): void {
  // List active zen streaming sessions
  server.registerMethod('zen.sessions', async () => {
    return { sessions: globalPeerStream.listSessions() };
  });

  // Subscribe to a zen session — viewer will receive zen.frame events
  server.registerMethod(
    'zen.subscribe',
    async (params: { sessionId: string }) => {
      const session = globalPeerStream.getSession(params.sessionId);
      if (!session) {
        return { error: 'Session not found', sessionId: params.sessionId };
      }
      globalPeerStream.addViewer(params.sessionId);
      const lastFrame = globalPeerStream.getLastFrame(params.sessionId);
      return {
        subscribed: true,
        sessionId: params.sessionId,
        name: session.name,
        lastFrame,
      };
    }
  );

  // Unsubscribe from a zen session
  server.registerMethod(
    'zen.unsubscribe',
    async (params: { sessionId: string }) => {
      globalPeerStream.removeViewer(params.sessionId);
      return { unsubscribed: true, sessionId: params.sessionId };
    }
  );

  // Get latest frame for a session (late-join catch-up)
  server.registerMethod(
    'zen.lastframe',
    async (params: { sessionId: string }) => {
      const frame = globalPeerStream.getLastFrame(params.sessionId);
      if (frame === null) {
        return { error: 'Session not found', sessionId: params.sessionId };
      }
      return { sessionId: params.sessionId, frame };
    }
  );
}
