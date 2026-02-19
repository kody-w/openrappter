/**
 * Enhanced streaming support for agent responses.
 *
 * StreamBlock is the atomic unit of streamed output. Each block has a type
 * ('text', 'tool_call', 'tool_result', 'thinking', 'error'), and may
 * accumulate content via deltas before being marked done.
 *
 * StreamManager maintains sessions keyed by a caller-supplied id, notifies
 * subscribers on every mutation, and integrates with the WebSocket gateway
 * for real-time delivery via broadcastEvent.
 */

import { randomUUID } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────

export type BlockType = 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error';

export interface StreamBlock {
  id: string;
  type: BlockType;
  content: string;
  /** Incremental content appended in the most recent pushDelta call */
  delta?: string;
  metadata?: Record<string, unknown>;
  done: boolean;
  timestamp: number;
}

export type SessionStatus = 'active' | 'complete' | 'error';

export interface StreamSession {
  id: string;
  blocks: StreamBlock[];
  status: SessionStatus;
  createdAt: number;
  completedAt?: number;
}

/** Callback invoked whenever a block is pushed or updated */
export type BlockCallback = (block: StreamBlock, session: StreamSession) => void;

// ── Gateway integration shim ───────────────────────────────────────────────

/**
 * Minimal interface for the GatewayServer broadcastEvent method so that
 * StreamManager can push blocks over WebSocket without a hard dependency on
 * the full GatewayServer class.
 */
export interface GatewayBroadcaster {
  broadcastEvent(event: string, payload: unknown, filter?: (conn: unknown) => boolean): void;
}

// ── StreamManager ─────────────────────────────────────────────────────────

export class StreamManager {
  private sessions = new Map<string, StreamSession>();
  private subscribers = new Map<string, Set<BlockCallback>>();
  private gateway?: GatewayBroadcaster;

  constructor(gateway?: GatewayBroadcaster) {
    this.gateway = gateway;
  }

  /**
   * Attach (or replace) the gateway broadcaster used for real-time delivery.
   */
  setGateway(gateway: GatewayBroadcaster): void {
    this.gateway = gateway;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  /**
   * Start a new streaming session. If a session with this id already exists
   * it is reset to an empty active state.
   */
  createSession(id: string): StreamSession {
    const session: StreamSession = {
      id,
      blocks: [],
      status: 'active',
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Mark a session as complete. No further blocks should be pushed after this.
   */
  complete(sessionId: string): StreamSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'complete';
    session.completedAt = Date.now();
    return session;
  }

  /**
   * Mark a session as errored.
   */
  error(sessionId: string): StreamSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = 'error';
    session.completedAt = Date.now();
    return session;
  }

  /** Return the current session snapshot (blocks are a reference, not a copy). */
  getSession(sessionId: string): StreamSession | undefined {
    return this.sessions.get(sessionId);
  }

  // ── Block operations ───────────────────────────────────────────────────

  /**
   * Push a new block into the session. If a block with the same id already
   * exists it is replaced. Returns the (potentially updated) block.
   */
  pushBlock(sessionId: string, block: Omit<StreamBlock, 'id' | 'timestamp'> & { id?: string }): StreamBlock {
    const session = this.requireSession(sessionId);

    const resolved: StreamBlock = {
      id: block.id ?? randomUUID(),
      type: block.type,
      content: block.content,
      delta: block.delta,
      metadata: block.metadata,
      done: block.done,
      timestamp: Date.now(),
    };

    const existing = session.blocks.findIndex((b) => b.id === resolved.id);
    if (existing >= 0) {
      session.blocks[existing] = resolved;
    } else {
      session.blocks.push(resolved);
    }

    this.notify(sessionId, resolved, session);
    return resolved;
  }

  /**
   * Append a text delta to an existing block's content. Creates the block as
   * a 'text' block if it does not yet exist. Returns the updated block.
   */
  pushDelta(sessionId: string, blockId: string, delta: string): StreamBlock {
    const session = this.requireSession(sessionId);

    let block = session.blocks.find((b) => b.id === blockId);
    if (!block) {
      block = {
        id: blockId,
        type: 'text',
        content: '',
        done: false,
        timestamp: Date.now(),
      };
      session.blocks.push(block);
    }

    block.content += delta;
    block.delta = delta;
    block.timestamp = Date.now();

    this.notify(sessionId, block, session);
    return block;
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * Subscribe to block updates for a session. The callback is invoked
   * synchronously on each pushBlock / pushDelta call.
   * Returns an unsubscribe function.
   */
  onBlock(sessionId: string, callback: BlockCallback): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    return () => {
      const set = this.subscribers.get(sessionId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.subscribers.delete(sessionId);
      }
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  /** Remove a completed session and its subscribers from memory. */
  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.subscribers.delete(sessionId);
  }

  /** Return the number of active (non-complete, non-error) sessions. */
  activeSessions(): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.status === 'active') count++;
    }
    return count;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private requireSession(sessionId: string): StreamSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`StreamSession '${sessionId}' not found`);
    return session;
  }

  private notify(sessionId: string, block: StreamBlock, session: StreamSession): void {
    // Notify local subscribers
    const set = this.subscribers.get(sessionId);
    if (set) {
      for (const cb of set) {
        try { cb(block, session); } catch { /* isolate subscriber errors */ }
      }
    }

    // Deliver over WebSocket gateway if attached
    if (this.gateway) {
      try {
        this.gateway.broadcastEvent('stream.block', {
          sessionId,
          block,
          sessionStatus: session.status,
        });
      } catch { /* ignore gateway errors */ }
    }
  }
}

/** Module-level singleton for convenience */
export const streamManager = new StreamManager();
