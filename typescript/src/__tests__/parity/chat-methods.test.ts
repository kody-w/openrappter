/**
 * Chat Methods Parity Tests
 *
 * Tests chat.abort and chat.inject RPC method implementations
 * with dependency injection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerChatMethods } from '../../gateway/methods/chat-methods.js';
import type { ChatMethodsDeps } from '../../gateway/methods/chat-methods.js';

// ── Mock server ──

interface RegisteredHandler {
  handler: (params: unknown, connection: unknown) => Promise<unknown>;
  options?: { requiresAuth?: boolean };
}

function createMockServer() {
  const methods = new Map<string, RegisteredHandler>();
  return {
    registerMethod<P, R>(
      name: string,
      handler: (params: P, connection: unknown) => Promise<R>,
      options?: { requiresAuth?: boolean },
    ) {
      methods.set(name, { handler: handler as RegisteredHandler['handler'], options });
    },
    methods,
    async call<P, R>(name: string, params: P): Promise<R> {
      const entry = methods.get(name);
      if (!entry) throw new Error(`Method not found: ${name}`);
      return entry.handler(params, {}) as Promise<R>;
    },
  };
}

describe('Chat Methods', () => {
  describe('Handler registration', () => {
    it('should register chat.abort method', () => {
      const server = createMockServer();
      registerChatMethods(server);
      expect(server.methods.has('chat.abort')).toBe(true);
    });

    it('should register chat.inject method', () => {
      const server = createMockServer();
      registerChatMethods(server);
      expect(server.methods.has('chat.inject')).toBe(true);
    });
  });

  describe('chat.abort', () => {
    it('should abort an active run', async () => {
      const server = createMockServer();
      const controller = new AbortController();
      const abortSpy = vi.spyOn(controller, 'abort');
      const abortControllers = new Map([['run-123', controller]]);
      registerChatMethods(server, { abortControllers });

      const result = await server.call<{ runId: string }, { status: string; runId: string }>(
        'chat.abort',
        { runId: 'run-123' },
      );

      expect(result.status).toBe('aborted');
      expect(result.runId).toBe('run-123');
      expect(abortSpy).toHaveBeenCalled();
      expect(abortControllers.has('run-123')).toBe(false);
    });

    it('should return not_found for unknown runId', async () => {
      const server = createMockServer();
      registerChatMethods(server);

      const result = await server.call<{ runId: string }, { status: string; runId: string }>(
        'chat.abort',
        { runId: 'nonexistent' },
      );

      expect(result.status).toBe('not_found');
      expect(result.runId).toBe('nonexistent');
    });
  });

  describe('chat.inject', () => {
    it('should store message in existing session', async () => {
      const server = createMockServer();
      const sessionStore = new Map([
        ['sess-1', { id: 'sess-1', messages: [] as Array<{ messageId: string; role: string; content: string; timestamp: number }> }],
      ]);
      registerChatMethods(server, { sessionStore });

      const result = await server.call<
        { sessionId: string; content: string; role?: string },
        { status: string; messageId: string; sessionId: string }
      >('chat.inject', { sessionId: 'sess-1', content: 'Hello world', role: 'user' });

      expect(result.status).toBe('ok');
      expect(result.messageId).toMatch(/^msg_/);
      expect(result.sessionId).toBe('sess-1');
      expect(sessionStore.get('sess-1')!.messages).toHaveLength(1);
      expect(sessionStore.get('sess-1')!.messages[0].content).toBe('Hello world');
      expect(sessionStore.get('sess-1')!.messages[0].role).toBe('user');
    });

    it('should create session if missing', async () => {
      const server = createMockServer();
      const sessionStore = new Map<string, { id: string; messages: Array<{ messageId: string; role: string; content: string; timestamp: number }> }>();
      registerChatMethods(server, { sessionStore });

      const result = await server.call<
        { sessionId: string; content: string },
        { status: string; messageId: string; sessionId: string }
      >('chat.inject', { sessionId: 'new-sess', content: 'First message' });

      expect(result.status).toBe('ok');
      expect(sessionStore.has('new-sess')).toBe(true);
      expect(sessionStore.get('new-sess')!.messages).toHaveLength(1);
    });

    it('should return a messageId', async () => {
      const server = createMockServer();
      registerChatMethods(server);

      const result = await server.call<
        { sessionId: string; content: string },
        { status: string; messageId: string; sessionId: string }
      >('chat.inject', { sessionId: 'sess-x', content: 'Test' });

      expect(result.messageId).toBeDefined();
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId.startsWith('msg_')).toBe(true);
    });
  });

  describe('Default deps', () => {
    it('should work without explicit deps', async () => {
      const server = createMockServer();
      registerChatMethods(server);

      // chat.abort should return not_found (empty map)
      const abortResult = await server.call<{ runId: string }, { status: string }>(
        'chat.abort',
        { runId: 'any' },
      );
      expect(abortResult.status).toBe('not_found');

      // chat.inject should create a session
      const injectResult = await server.call<
        { sessionId: string; content: string },
        { status: string; messageId: string }
      >('chat.inject', { sessionId: 'auto-sess', content: 'hi' });
      expect(injectResult.status).toBe('ok');
    });
  });
});
