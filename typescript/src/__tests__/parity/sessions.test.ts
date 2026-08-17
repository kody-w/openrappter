/**
 * Session Management Parity Tests
 *
 * Exercises the real StorageAdapter (src/storage/sqlite.ts, in-memory mode) —
 * the code that actually persists sessions. The previous version of this file
 * built literal session/response objects and asserted on their own shape, so it
 * passed no matter what the product did (e.g. it "verified" transcript storage
 * with `expect('~/.openrappter/sessions/x.jsonl').toContain('.jsonl')`, a string
 * compared against a substring of itself). These tests save real sessions and
 * assert on what comes back out.
 *
 * showcase-persistence-vault.test.ts covers the save/get/delete happy path and
 * channelId filtering; this file deliberately covers the rest of the isolation
 * surface — userId / conversationId / agentId filtering, message + tool-call
 * round-tripping, and metadata updates via upsert.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createStorageAdapter } from '../../storage/index.js';
import type { StorageAdapter, Session } from '../../storage/types.js';

let storage: StorageAdapter;

beforeEach(async () => {
  storage = createStorageAdapter({ type: 'memory', inMemory: true });
  await storage.initialize();
});

afterEach(async () => {
  await storage.close();
});

function makeSession(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  const now = new Date().toISOString();
  return {
    channelId: 'cli',
    conversationId: 'conv',
    agentId: 'main',
    metadata: {},
    messages: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Session Management Parity', () => {
  describe('Session CRUD', () => {
    it('round-trips a session by id, including messages and metadata', async () => {
      await storage.saveSession(
        makeSession({
          id: 'session_abc123',
          userId: 'user_789',
          metadata: { topic: 'code-review' },
          messages: [
            { id: 'm1', role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
            { id: 'm2', role: 'assistant', content: 'Hi!', timestamp: new Date().toISOString() },
          ],
        })
      );

      const got = await storage.getSession('session_abc123');
      expect(got).not.toBeNull();
      expect(got!.userId).toBe('user_789');
      expect(got!.metadata.topic).toBe('code-review');
      expect(got!.messages).toHaveLength(2);
      expect(got!.messages[1].content).toBe('Hi!');
    });

    it('returns null for a session that was never saved', async () => {
      expect(await storage.getSession('missing')).toBeNull();
    });

    it('deletes only the target session', async () => {
      await storage.saveSession(makeSession({ id: 's1' }));
      await storage.saveSession(makeSession({ id: 's2' }));

      await storage.deleteSession('s1');

      expect(await storage.getSession('s1')).toBeNull();
      expect(await storage.getSession('s2')).not.toBeNull();
    });

    it('updates session metadata via upsert without creating a duplicate', async () => {
      await storage.saveSession(makeSession({ id: 's1', metadata: { priority: 'low' } }));
      await storage.saveSession(makeSession({ id: 's1', metadata: { priority: 'high' } }));

      const all = await storage.listSessions();
      expect(all).toHaveLength(1);
      expect((await storage.getSession('s1'))!.metadata.priority).toBe('high');
    });
  });

  describe('Session isolation via filters', () => {
    beforeEach(async () => {
      await storage.saveSession(makeSession({ id: 's_alice', userId: 'alice', channelId: 'telegram', conversationId: 'c1', agentId: 'main' }));
      await storage.saveSession(makeSession({ id: 's_bob', userId: 'bob', channelId: 'telegram', conversationId: 'c2', agentId: 'writer' }));
      await storage.saveSession(makeSession({ id: 's_bob2', userId: 'bob', channelId: 'discord', conversationId: 'c2', agentId: 'main' }));
    });

    it('isolates sessions per user', async () => {
      const alice = await storage.listSessions({ userId: 'alice' });
      expect(alice.map((s) => s.id)).toEqual(['s_alice']);

      const bob = await storage.listSessions({ userId: 'bob' });
      expect(bob.map((s) => s.id).sort()).toEqual(['s_bob', 's_bob2']);
    });

    it('isolates sessions per channel', async () => {
      const discord = await storage.listSessions({ channelId: 'discord' });
      expect(discord.map((s) => s.id)).toEqual(['s_bob2']);
    });

    it('filters sessions by conversationId', async () => {
      const c2 = await storage.listSessions({ conversationId: 'c2' });
      expect(c2.map((s) => s.id).sort()).toEqual(['s_bob', 's_bob2']);
    });

    it('filters sessions by agentId', async () => {
      const main = await storage.listSessions({ agentId: 'main' });
      expect(main.map((s) => s.id).sort()).toEqual(['s_alice', 's_bob2']);
    });

    it('respects the limit on listSessions', async () => {
      const limited = await storage.listSessions({ limit: 2 });
      expect(limited).toHaveLength(2);
    });
  });

  describe('Context persistence', () => {
    it('persists tool-call records on messages', async () => {
      await storage.saveSession(
        makeSession({
          id: 'with_tools',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: '',
              timestamp: new Date().toISOString(),
              toolCalls: [
                { id: 'tc_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
              ],
            },
            {
              id: 'm2',
              role: 'tool',
              content: 'file1.ts\nfile2.ts',
              toolCallId: 'tc_1',
              timestamp: new Date().toISOString(),
            },
          ],
        })
      );

      const got = await storage.getSession('with_tools');
      expect(got!.messages[0].toolCalls).toHaveLength(1);
      expect(got!.messages[0].toolCalls![0].function.name).toBe('bash');
      expect(got!.messages[1].toolCallId).toBe('tc_1');
    });
  });
});
