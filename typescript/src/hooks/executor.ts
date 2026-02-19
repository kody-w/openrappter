/**
 * Hook Executor
 *
 * Executes hook handlers at lifecycle points with:
 * - Error isolation (one hook failure does not stop the others)
 * - Per-handler timeout enforcement (configurable, default 30 s)
 * - Three execution strategies:
 *   · run          – fire all handlers, collect results / errors
 *   · runWaterfall – each handler may transform context.data for the next
 *   · runBail      – stop on the first handler that returns { bail: true }
 */

import type {
  HookPhase,
  HookContext,
  HookResult,
  HookHandler,
  ExecutionOptions,
  ExecutionSummary,
} from './types.js';
import type { HookRegistry } from './registry.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Wraps a single handler invocation with a configurable timeout.
 * Rejects with an error message if the handler does not settle in time.
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  hookId: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Hook "${hookId}" timed out after ${ms} ms`));
    }, ms);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Invoke a single handler with timeout and error capturing.
 * Returns the result or an error object; never throws.
 */
async function invokeHandler(
  hook: HookHandler,
  ctx: HookContext,
  defaultTimeout: number
): Promise<{ result: HookResult | void; error?: Error }> {
  const timeout = hook.timeout ?? defaultTimeout;
  try {
    const result = await withTimeout(() => hook.handler(ctx), timeout, hook.id);
    return { result };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { result: undefined, error };
  }
}

export class HookExecutor {
  constructor(private readonly registry: HookRegistry) {}

  /**
   * Execute all hooks registered for `phase`.
   *
   * Each hook runs to completion (or timeout) regardless of whether others
   * succeed or fail. Errors are collected in the summary, not propagated.
   *
   * @param phase   - Lifecycle phase.
   * @param context - Mutable context object shared across all hooks.
   * @param options - Timeout and error-isolation settings.
   */
  async run(
    phase: HookPhase,
    context: HookContext,
    options: ExecutionOptions = {}
  ): Promise<ExecutionSummary> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const isolate = options.isolateErrors !== false;
    const handlers = this.registry.getHandlers(phase);
    const errors: Array<{ hookId: string; error: Error }> = [];

    for (const hook of handlers) {
      const { error } = await invokeHandler(hook, context, timeout);
      if (error) {
        if (!isolate) throw error;
        errors.push({ hookId: hook.id, error });
        this.logError(hook, error);
      } else {
        this.logSuccess(hook);
      }
    }

    return {
      phase,
      ran: handlers.length,
      errors,
      context,
      bailed: false,
    };
  }

  /**
   * Execute hooks in a waterfall where each hook can mutate context.data
   * for the hook that follows it.
   *
   * If a hook returns `{ data: {...} }`, that data is shallow-merged into
   * context.data before the next hook runs.
   *
   * @param phase   - Lifecycle phase.
   * @param context - Mutable context; data evolves across hooks.
   * @param options - Timeout and error-isolation settings.
   */
  async runWaterfall(
    phase: HookPhase,
    context: HookContext,
    options: ExecutionOptions = {}
  ): Promise<ExecutionSummary> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const isolate = options.isolateErrors !== false;
    const handlers = this.registry.getHandlers(phase);
    const errors: Array<{ hookId: string; error: Error }> = [];

    for (const hook of handlers) {
      const { result, error } = await invokeHandler(hook, context, timeout);
      if (error) {
        if (!isolate) throw error;
        errors.push({ hookId: hook.id, error });
        this.logError(hook, error);
      } else {
        this.logSuccess(hook);
        // Merge returned data into the shared context
        if (result && typeof result === 'object' && result.data) {
          context.data = { ...context.data, ...result.data };
        }
      }
    }

    return {
      phase,
      ran: handlers.length,
      errors,
      context,
      bailed: false,
    };
  }

  /**
   * Execute hooks in order until one returns `{ bail: true }`.
   *
   * Like runWaterfall, data is propagated between hooks. On bail the
   * summary marks `bailed: true` and remaining hooks are skipped.
   *
   * @param phase   - Lifecycle phase.
   * @param context - Mutable context.
   * @param options - Timeout and error-isolation settings.
   */
  async runBail(
    phase: HookPhase,
    context: HookContext,
    options: ExecutionOptions = {}
  ): Promise<ExecutionSummary> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const isolate = options.isolateErrors !== false;
    const handlers = this.registry.getHandlers(phase);
    const errors: Array<{ hookId: string; error: Error }> = [];
    let bailed = false;
    let ran = 0;

    for (const hook of handlers) {
      ran++;
      const { result, error } = await invokeHandler(hook, context, timeout);
      if (error) {
        if (!isolate) throw error;
        errors.push({ hookId: hook.id, error });
        this.logError(hook, error);
      } else {
        this.logSuccess(hook);
        if (result && typeof result === 'object') {
          // Propagate data to subsequent hooks
          if (result.data) {
            context.data = { ...context.data, ...result.data };
          }
          // Stop on explicit bail signal
          if (result.bail === true) {
            bailed = true;
            break;
          }
        }
      }
    }

    return {
      phase,
      ran,
      errors,
      context,
      bailed,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private logSuccess(hook: HookHandler): void {
    const src = hook.source ? ` [${hook.source}]` : '';
    console.debug(
      `[hooks] ${hook.phase} • ${hook.id}${src} ✓ (priority ${hook.priority})`
    );
  }

  private logError(hook: HookHandler, error: Error): void {
    const src = hook.source ? ` [${hook.source}]` : '';
    console.warn(
      `[hooks] ${hook.phase} • ${hook.id}${src} failed: ${error.message}`
    );
  }
}
