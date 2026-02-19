/**
 * Lifecycle Hooks System - Type Definitions
 *
 * Defines the hook phases, handler contracts, and context shapes used
 * throughout the hooks registry, loader, and executor.
 */

/**
 * All lifecycle phases hooks can be registered for.
 */
export type HookPhase =
  | 'boot'
  | 'shutdown'
  | 'message.incoming'
  | 'message.outgoing'
  | 'agent.before'
  | 'agent.after'
  | 'channel.connect'
  | 'channel.disconnect'
  | 'cron.tick'
  | 'error';

/**
 * The context object passed to every hook handler.
 */
export interface HookContext {
  phase: HookPhase;
  timestamp: Date;
  /** Mutable payload the hook may read or transform. */
  data: Record<string, unknown>;
  /** Read-only metadata about the event (sender, channel id, etc.). */
  metadata: Record<string, unknown>;
}

/**
 * Optional return value from a hook handler.
 *
 * - `data`  – merged into the context for the next hook in runWaterfall
 * - `bail`  – if true, stops execution in runBail
 * - `error` – captured and isolated; does not propagate unless re-thrown
 */
export interface HookResult {
  data?: Record<string, unknown>;
  bail?: boolean;
  error?: Error;
}

/**
 * A fully-resolved hook handler entry kept in the registry.
 */
export interface HookHandler {
  id: string;
  phase: HookPhase;
  /** Handlers run in ascending priority order (lower number = runs first). */
  priority: number;
  handler: (context: HookContext) => Promise<HookResult | void>;
  /** Per-handler timeout in milliseconds (overrides executor default). */
  timeout?: number;
  /** Human-readable origin: file path or plugin name. */
  source?: string;
}

/**
 * Parsed representation of a HOOK.md file on disk.
 */
export interface HookDefinition {
  /** Unique identifier derived from the filename or frontmatter `id`. */
  id: string;
  /** Display name from frontmatter. */
  name: string;
  /** Hook phase this file targets. */
  phase: HookPhase;
  /** Priority from frontmatter (default 100). */
  priority: number;
  /** Optional timeout override in milliseconds. */
  timeout?: number;
  /** Raw extracted code block (TypeScript or JavaScript). */
  code: string;
  /** Absolute path to the source file. */
  filePath: string;
}

/**
 * Options accepted by HookExecutor.run / runWaterfall / runBail.
 */
export interface ExecutionOptions {
  /** Default timeout in milliseconds (default 30 000). */
  timeout?: number;
  /** If false, errors from individual hooks are suppressed (default true). */
  isolateErrors?: boolean;
}

/**
 * Summary returned after executing a phase.
 */
export interface ExecutionSummary {
  phase: HookPhase;
  ran: number;
  errors: Array<{ hookId: string; error: Error }>;
  /** Final context after all hooks have run. */
  context: HookContext;
  /** Whether execution was bailed early (runBail mode only). */
  bailed: boolean;
}
