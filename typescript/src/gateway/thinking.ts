/**
 * Support for AI model "thinking" / reasoning tokens.
 *
 * ThinkingManager captures extended thinking output produced by models that
 * support it (e.g., Claude with extended thinking enabled). Thinking blocks
 * may optionally be:
 *   - streamed to the client (controlled by config.streamThinking)
 *   - redacted before delivery (replaces content with a placeholder)
 *
 * ThinkingManager integrates with StreamManager so thinking blocks flow
 * through the same pipeline as other streamed content.
 */

import { randomUUID } from 'crypto';
import type { StreamManager } from './streaming.js';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ThinkingBlock {
  id: string;
  /** Raw thinking content as emitted by the model */
  content: string;
  /**
   * Whether this block has been redacted. When true, `content` holds the
   * placeholder string rather than the original thinking output.
   */
  redacted: boolean;
  timestamp: number;
}

export interface ThinkingConfig {
  /**
   * When true, thinking blocks are forwarded to the client over WebSocket.
   * Default: false (thinking is captured but not streamed).
   */
  streamThinking?: boolean;
  /**
   * When true, all thinking blocks are redacted before any delivery.
   * Takes precedence over streamThinking.
   * Default: false.
   */
  redactAll?: boolean;
  /** Placeholder text used when a block is redacted. */
  redactedPlaceholder?: string;
}

// ── ThinkingManager ───────────────────────────────────────────────────────

export class ThinkingManager {
  private blocks = new Map<string, ThinkingBlock[]>(); // keyed by sessionId
  private config: Required<ThinkingConfig>;
  private streamManager?: StreamManager;

  constructor(config?: ThinkingConfig, streamManager?: StreamManager) {
    this.config = {
      streamThinking: config?.streamThinking ?? false,
      redactAll: config?.redactAll ?? false,
      redactedPlaceholder: config?.redactedPlaceholder ?? '[thinking redacted]',
    };
    this.streamManager = streamManager;
  }

  // ── Configuration ──────────────────────────────────────────────────────

  /** Replace the current config (useful for hot-reloading). */
  configure(config: ThinkingConfig): void {
    this.config = {
      streamThinking: config.streamThinking ?? this.config.streamThinking,
      redactAll: config.redactAll ?? this.config.redactAll,
      redactedPlaceholder: config.redactedPlaceholder ?? this.config.redactedPlaceholder,
    };
  }

  /**
   * Attach a StreamManager so thinking blocks are pushed as 'thinking'-type
   * stream blocks when streamThinking is enabled.
   */
  setStreamManager(manager: StreamManager): void {
    this.streamManager = manager;
  }

  // ── Core API ───────────────────────────────────────────────────────────

  /**
   * Capture a thinking block for the given session.
   *
   * If redactAll is set the content is immediately replaced with the
   * placeholder. If streamThinking is enabled (and the block is not
   * redacted-only) the block is forwarded to the StreamManager.
   *
   * Returns the stored ThinkingBlock.
   */
  capture(sessionId: string, content: string): ThinkingBlock {
    const shouldRedact = this.config.redactAll;

    const block: ThinkingBlock = {
      id: randomUUID(),
      content: shouldRedact ? this.config.redactedPlaceholder : content,
      redacted: shouldRedact,
      timestamp: Date.now(),
    };

    if (!this.blocks.has(sessionId)) {
      this.blocks.set(sessionId, []);
    }
    this.blocks.get(sessionId)!.push(block);

    // Forward to StreamManager when streaming is enabled
    if (this.shouldStream(this.config) && this.streamManager) {
      try {
        // Ensure the session exists in StreamManager (it may have been
        // created by the calling code already; pushBlock is idempotent for
        // new blocks).
        this.streamManager.pushBlock(sessionId, {
          id: block.id,
          type: 'thinking',
          content: block.content,
          done: true,
          metadata: { redacted: block.redacted },
        });
      } catch { /* StreamManager session may not exist yet; ignore */ }
    }

    return block;
  }

  /**
   * Return true when thinking blocks should be delivered to the client
   * given the provided config snapshot.
   */
  shouldStream(config: ThinkingConfig): boolean {
    if (config.redactAll) return false;
    return config.streamThinking === true;
  }

  /**
   * Redact a block in-place: replaces content with the placeholder and marks
   * it as redacted. Returns the updated block, or undefined if not found.
   */
  redact(block: ThinkingBlock): ThinkingBlock {
    block.content = this.config.redactedPlaceholder;
    block.redacted = true;
    return block;
  }

  // ── Retrieval ──────────────────────────────────────────────────────────

  /** Return all thinking blocks captured for a session. */
  getBlocks(sessionId: string): ThinkingBlock[] {
    return this.blocks.get(sessionId) ?? [];
  }

  /** Remove all blocks for a session (e.g., after delivery or cleanup). */
  clearSession(sessionId: string): void {
    this.blocks.delete(sessionId);
  }

  /** Total number of sessions with captured thinking blocks. */
  sessionCount(): number {
    return this.blocks.size;
  }
}

/** Module-level singleton with default config (streaming disabled). */
export const thinkingManager = new ThinkingManager();
