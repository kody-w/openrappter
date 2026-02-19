/**
 * Hook Registry
 *
 * Central store for lifecycle hook handlers. Handlers are sorted by
 * ascending priority (lower = runs first) and can be registered or
 * removed at runtime.
 *
 * Usage:
 *   const registry = new HookRegistry();
 *   const id = registry.register('boot', async (ctx) => { ... }, 50);
 *   registry.unregister(id);
 *   const handlers = registry.getHandlers('boot');
 */

import { randomUUID } from 'crypto';
import type { HookPhase, HookHandler, HookContext, HookResult } from './types.js';

export class HookRegistry {
  private handlers = new Map<string, HookHandler>();

  /**
   * Register a hook handler for a given phase.
   *
   * @param phase    - Lifecycle phase to hook into.
   * @param handler  - Async function executed at the phase boundary.
   * @param priority - Sort order: lower numbers run first (default 100).
   * @param options  - Optional metadata: timeout, source, custom id.
   * @returns The generated hook id (use to unregister later).
   */
  register(
    phase: HookPhase,
    handler: (context: HookContext) => Promise<HookResult | void>,
    priority = 100,
    options: { timeout?: number; source?: string; id?: string } = {}
  ): string {
    const id = options.id ?? randomUUID();

    const entry: HookHandler = {
      id,
      phase,
      priority,
      handler,
      timeout: options.timeout,
      source: options.source,
    };

    this.handlers.set(id, entry);
    return id;
  }

  /**
   * Remove a previously registered hook.
   *
   * @param hookId - The id returned by `register()`.
   * @returns true if the hook was found and removed, false otherwise.
   */
  unregister(hookId: string): boolean {
    return this.handlers.delete(hookId);
  }

  /**
   * Retrieve all handlers registered for a phase, sorted by priority ascending.
   *
   * @param phase - Lifecycle phase to query.
   */
  getHandlers(phase: HookPhase): HookHandler[] {
    const matching: HookHandler[] = [];
    for (const entry of this.handlers.values()) {
      if (entry.phase === phase) {
        matching.push(entry);
      }
    }
    return matching.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Retrieve a specific handler by id.
   *
   * @param hookId - The id returned by `register()`.
   */
  getHandler(hookId: string): HookHandler | undefined {
    return this.handlers.get(hookId);
  }

  /**
   * Return all registered phases that have at least one handler.
   */
  getActivePhases(): HookPhase[] {
    const phases = new Set<HookPhase>();
    for (const entry of this.handlers.values()) {
      phases.add(entry.phase);
    }
    return Array.from(phases);
  }

  /**
   * Total number of registered hooks across all phases.
   */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Remove all registered hooks (useful for testing or full teardown).
   */
  clear(): void {
    this.handlers.clear();
  }
}
