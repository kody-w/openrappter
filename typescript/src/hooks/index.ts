/**
 * Lifecycle Hooks System
 *
 * Provides a markdown-driven, priority-ordered hook system for
 * intercepting lifecycle events in openrappter.
 *
 * Exports:
 *   - HookRegistry — register / unregister / query handlers
 *   - HookExecutor — run / runWaterfall / runBail execution strategies
 *   - HookLoader   — discover and compile HOOK.md files
 *   - All types    — HookPhase, HookHandler, HookContext, HookResult, etc.
 *
 * Quick start:
 *
 *   import { HookRegistry, HookExecutor, HookLoader } from './hooks/index.js';
 *
 *   const registry = new HookRegistry();
 *   const executor = new HookExecutor(registry);
 *   const loader   = new HookLoader();
 *
 *   // Register an inline hook
 *   registry.register('boot', async (ctx) => {
 *     console.log('booting at', ctx.timestamp);
 *   }, 50);
 *
 *   // Load hooks from ~/.openrappter/hooks/
 *   await loader.loadIntoRegistry(registry);
 *
 *   // Fire all boot hooks
 *   const summary = await executor.run('boot', {
 *     phase: 'boot',
 *     timestamp: new Date(),
 *     data: {},
 *     metadata: {},
 *   });
 */

export { HookRegistry } from './registry.js';
export { HookExecutor } from './executor.js';
export { HookLoader } from './loader.js';

export type {
  HookPhase,
  HookHandler,
  HookContext,
  HookResult,
  HookDefinition,
  ExecutionOptions,
  ExecutionSummary,
} from './types.js';
