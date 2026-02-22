/**
 * Showcase: Stream Weaver
 *
 * Tests StreamManager: sessions, blocks, deltas, subscribers, lifecycle.
 * No agents needed — uses StreamManager directly.
 */

import { describe, it, expect } from 'vitest';
import { StreamManager } from '../../gateway/streaming.js';
import type { StreamBlock, StreamSession } from '../../gateway/streaming.js';

describe('Showcase: Stream Weaver', () => {
  describe('Session lifecycle', () => {
    it('should create an active session', () => {
      const manager = new StreamManager();
      const session = manager.createSession('sess_1');

      expect(session.id).toBe('sess_1');
      expect(session.status).toBe('active');
      expect(session.blocks).toEqual([]);
      expect(session.createdAt).toBeGreaterThan(0);
    });

    it('should complete a session', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');
      const completed = manager.complete('sess_1');

      expect(completed?.status).toBe('complete');
      expect(completed?.completedAt).toBeGreaterThan(0);
    });

    it('should error a session', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');
      const errored = manager.error('sess_1');

      expect(errored?.status).toBe('error');
      expect(errored?.completedAt).toBeGreaterThan(0);
    });
  });

  describe('Push blocks', () => {
    it('should push a text block', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');

      const block = manager.pushBlock('sess_1', {
        type: 'text',
        content: 'Hello world',
        done: false,
      });

      expect(block.id).toBeTruthy();
      expect(block.type).toBe('text');
      expect(block.content).toBe('Hello world');
      expect(block.done).toBe(false);

      const session = manager.getSession('sess_1');
      expect(session?.blocks.length).toBe(1);
    });

    it('should push multiple block types', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');

      manager.pushBlock('sess_1', { type: 'text', content: 'Thinking...', done: false });
      manager.pushBlock('sess_1', { type: 'tool_call', content: '{"name":"bash"}', done: true });
      manager.pushBlock('sess_1', { type: 'thinking', content: 'Processing...', done: false });

      const session = manager.getSession('sess_1');
      expect(session?.blocks.length).toBe(3);

      const types = session?.blocks.map(b => b.type);
      expect(types).toContain('text');
      expect(types).toContain('tool_call');
      expect(types).toContain('thinking');
    });
  });

  describe('Delta accumulation', () => {
    it('should accumulate content via pushDelta', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');

      manager.pushDelta('sess_1', 'block_1', 'Hello');
      manager.pushDelta('sess_1', 'block_1', ' world');
      const block = manager.pushDelta('sess_1', 'block_1', '!');

      expect(block.content).toBe('Hello world!');
      expect(block.delta).toBe('!'); // Most recent delta

      const session = manager.getSession('sess_1');
      expect(session?.blocks.length).toBe(1);
    });
  });

  describe('Subscribers', () => {
    it('should notify subscriber on pushBlock', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');

      const received: StreamBlock[] = [];
      manager.onBlock('sess_1', (block) => {
        received.push(block);
      });

      manager.pushBlock('sess_1', { type: 'text', content: 'Hello', done: false });
      manager.pushBlock('sess_1', { type: 'text', content: 'World', done: true });

      expect(received.length).toBe(2);
      expect(received[0].content).toBe('Hello');
      expect(received[1].content).toBe('World');
    });

    it('should unsubscribe cleanly', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');

      const received: StreamBlock[] = [];
      const unsub = manager.onBlock('sess_1', (block) => {
        received.push(block);
      });

      manager.pushBlock('sess_1', { type: 'text', content: 'First', done: false });
      unsub();
      manager.pushBlock('sess_1', { type: 'text', content: 'Second', done: false });

      expect(received.length).toBe(1);
    });
  });

  describe('Active sessions count', () => {
    it('should track active vs completed sessions', () => {
      const manager = new StreamManager();
      manager.createSession('sess_1');
      manager.createSession('sess_2');
      manager.createSession('sess_3');

      expect(manager.activeSessions()).toBe(3);

      manager.complete('sess_1');
      manager.error('sess_2');

      expect(manager.activeSessions()).toBe(1);
    });
  });
});
