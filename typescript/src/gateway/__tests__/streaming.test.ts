/**
 * Tests for StreamManager — block streaming, deltas, session lifecycle,
 * subscriber callbacks, and gateway integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamManager, streamManager } from '../streaming.js';
import type { StreamBlock, StreamSession, GatewayBroadcaster } from '../streaming.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function makeGateway(): GatewayBroadcaster & { calls: Array<{ event: string; payload: unknown }> } {
  const calls: Array<{ event: string; payload: unknown }> = [];
  return {
    calls,
    broadcastEvent(event: string, payload: unknown) {
      calls.push({ event, payload });
    },
  };
}

// ── Session lifecycle ─────────────────────────────────────────────────────

describe('StreamManager — session lifecycle', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
  });

  it('creates a new session with status active', () => {
    const session = manager.createSession('s1');
    expect(session.id).toBe('s1');
    expect(session.status).toBe('active');
    expect(session.blocks).toHaveLength(0);
    expect(typeof session.createdAt).toBe('number');
  });

  it('resets an existing session on re-create', () => {
    manager.createSession('s1');
    manager.pushBlock('s1', { type: 'text', content: 'hello', done: false });
    const fresh = manager.createSession('s1');
    expect(fresh.blocks).toHaveLength(0);
    expect(fresh.status).toBe('active');
  });

  it('getSession returns the current session', () => {
    manager.createSession('s2');
    const session = manager.getSession('s2');
    expect(session).toBeDefined();
    expect(session!.id).toBe('s2');
  });

  it('getSession returns undefined for unknown id', () => {
    expect(manager.getSession('unknown')).toBeUndefined();
  });

  it('complete transitions status and sets completedAt', () => {
    manager.createSession('s3');
    const completed = manager.complete('s3');
    expect(completed!.status).toBe('complete');
    expect(typeof completed!.completedAt).toBe('number');
  });

  it('error transitions status', () => {
    manager.createSession('s4');
    const errored = manager.error('s4');
    expect(errored!.status).toBe('error');
    expect(typeof errored!.completedAt).toBe('number');
  });

  it('complete returns undefined for missing session', () => {
    expect(manager.complete('nope')).toBeUndefined();
  });

  it('activeSessions counts only active ones', () => {
    manager.createSession('a1');
    manager.createSession('a2');
    manager.createSession('a3');
    manager.complete('a2');
    manager.error('a3');
    expect(manager.activeSessions()).toBe(1);
  });

  it('deleteSession removes session and subscribers', () => {
    manager.createSession('del1');
    const cb = vi.fn();
    manager.onBlock('del1', cb);
    manager.deleteSession('del1');
    expect(manager.getSession('del1')).toBeUndefined();
    // No callback should fire after deletion
    manager.createSession('del1');
    manager.pushBlock('del1', { type: 'text', content: 'x', done: false });
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── pushBlock ─────────────────────────────────────────────────────────────

describe('StreamManager — pushBlock', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
    manager.createSession('sess');
  });

  it('adds a new block with auto-generated id', () => {
    const block = manager.pushBlock('sess', { type: 'text', content: 'hello', done: false });
    expect(typeof block.id).toBe('string');
    expect(block.id.length).toBeGreaterThan(0);
    expect(block.type).toBe('text');
    expect(block.content).toBe('hello');
    expect(block.done).toBe(false);
    expect(typeof block.timestamp).toBe('number');

    const session = manager.getSession('sess')!;
    expect(session.blocks).toHaveLength(1);
  });

  it('respects a caller-supplied block id', () => {
    const block = manager.pushBlock('sess', { id: 'blk-custom', type: 'thinking', content: 'reasoning...', done: true });
    expect(block.id).toBe('blk-custom');
  });

  it('replaces an existing block with the same id', () => {
    manager.pushBlock('sess', { id: 'blk1', type: 'text', content: 'original', done: false });
    manager.pushBlock('sess', { id: 'blk1', type: 'text', content: 'updated', done: true });
    const session = manager.getSession('sess')!;
    expect(session.blocks).toHaveLength(1);
    expect(session.blocks[0].content).toBe('updated');
    expect(session.blocks[0].done).toBe(true);
  });

  it('supports all block types', () => {
    const types: Array<StreamBlock['type']> = ['text', 'tool_call', 'tool_result', 'thinking', 'error'];
    for (const type of types) {
      manager.pushBlock('sess', { type, content: type, done: false });
    }
    const session = manager.getSession('sess')!;
    expect(session.blocks.map((b) => b.type)).toEqual(types);
  });

  it('throws for unknown session id', () => {
    expect(() => manager.pushBlock('missing', { type: 'text', content: 'x', done: false }))
      .toThrow("StreamSession 'missing' not found");
  });

  it('stores metadata on the block', () => {
    const block = manager.pushBlock('sess', {
      type: 'tool_call',
      content: '{}',
      done: false,
      metadata: { toolName: 'bash', callId: 'tc-1' },
    });
    expect(block.metadata).toEqual({ toolName: 'bash', callId: 'tc-1' });
  });
});

// ── pushDelta ─────────────────────────────────────────────────────────────

describe('StreamManager — pushDelta', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
    manager.createSession('sess');
  });

  it('creates a new text block when blockId does not exist', () => {
    const block = manager.pushDelta('sess', 'blk-new', 'hello ');
    expect(block.id).toBe('blk-new');
    expect(block.type).toBe('text');
    expect(block.content).toBe('hello ');
    expect(block.delta).toBe('hello ');
  });

  it('appends deltas to an existing block', () => {
    manager.pushDelta('sess', 'blk-d', 'hello ');
    manager.pushDelta('sess', 'blk-d', 'world');
    const block = manager.getSession('sess')!.blocks[0];
    expect(block.content).toBe('hello world');
    expect(block.delta).toBe('world'); // only the last delta
  });

  it('only stores one block for repeated deltas to same id', () => {
    manager.pushDelta('sess', 'blk-d', 'a');
    manager.pushDelta('sess', 'blk-d', 'b');
    manager.pushDelta('sess', 'blk-d', 'c');
    expect(manager.getSession('sess')!.blocks).toHaveLength(1);
  });

  it('updates block timestamp on each delta', async () => {
    const b1 = manager.pushDelta('sess', 'blk-t', 'first');
    await new Promise((r) => setTimeout(r, 2));
    const b2 = manager.pushDelta('sess', 'blk-t', 'second');
    expect(b2.timestamp).toBeGreaterThanOrEqual(b1.timestamp);
  });
});

// ── Subscriptions ─────────────────────────────────────────────────────────

describe('StreamManager — onBlock subscriptions', () => {
  let manager: StreamManager;

  beforeEach(() => {
    manager = new StreamManager();
    manager.createSession('sub-sess');
  });

  it('invokes callback on pushBlock', () => {
    const cb = vi.fn();
    manager.onBlock('sub-sess', cb);
    manager.pushBlock('sub-sess', { type: 'text', content: 'hi', done: false });
    expect(cb).toHaveBeenCalledOnce();
    const [block, session] = cb.mock.calls[0] as [StreamBlock, StreamSession];
    expect(block.content).toBe('hi');
    expect(session.id).toBe('sub-sess');
  });

  it('invokes callback on pushDelta', () => {
    const cb = vi.fn();
    manager.onBlock('sub-sess', cb);
    manager.pushDelta('sub-sess', 'blk', 'delta');
    expect(cb).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops future callbacks', () => {
    const cb = vi.fn();
    const unsub = manager.onBlock('sub-sess', cb);
    unsub();
    manager.pushBlock('sub-sess', { type: 'text', content: 'after unsub', done: false });
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers on the same session', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.onBlock('sub-sess', cb1);
    manager.onBlock('sub-sess', cb2);
    manager.pushBlock('sub-sess', { type: 'text', content: 'x', done: false });
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it('isolates subscriber errors — other callbacks still fire', () => {
    const boom = vi.fn(() => { throw new Error('cb error'); });
    const safe = vi.fn();
    manager.onBlock('sub-sess', boom);
    manager.onBlock('sub-sess', safe);
    expect(() => manager.pushBlock('sub-sess', { type: 'text', content: 'x', done: false })).not.toThrow();
    expect(safe).toHaveBeenCalledOnce();
  });
});

// ── Gateway integration ───────────────────────────────────────────────────

describe('StreamManager — gateway integration', () => {
  it('broadcasts stream.block event when gateway is attached', () => {
    const gw = makeGateway();
    const manager = new StreamManager(gw);
    manager.createSession('gw-sess');
    manager.pushBlock('gw-sess', { type: 'text', content: 'hello', done: false });
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0].event).toBe('stream.block');
    const payload = gw.calls[0].payload as Record<string, unknown>;
    expect(payload['sessionId']).toBe('gw-sess');
    expect((payload['block'] as StreamBlock).content).toBe('hello');
  });

  it('broadcasts on pushDelta', () => {
    const gw = makeGateway();
    const manager = new StreamManager(gw);
    manager.createSession('gw-delta');
    manager.pushDelta('gw-delta', 'blk', 'part1');
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0].event).toBe('stream.block');
  });

  it('setGateway replaces the broadcaster', () => {
    const gw1 = makeGateway();
    const gw2 = makeGateway();
    const manager = new StreamManager(gw1);
    manager.setGateway(gw2);
    manager.createSession('gw-replace');
    manager.pushBlock('gw-replace', { type: 'text', content: 'x', done: false });
    expect(gw1.calls).toHaveLength(0);
    expect(gw2.calls).toHaveLength(1);
  });

  it('does not throw when no gateway is attached', () => {
    const manager = new StreamManager(); // no gateway
    manager.createSession('no-gw');
    expect(() => manager.pushBlock('no-gw', { type: 'text', content: 'x', done: false })).not.toThrow();
  });
});

// ── Module-level singleton ────────────────────────────────────────────────

describe('streamManager singleton', () => {
  it('is exported and is a StreamManager instance', () => {
    expect(streamManager).toBeInstanceOf(StreamManager);
  });
});
