/**
 * Plugin Hook System
 * Manages plugin hooks and their execution
 */

export type HookEvent =
  | 'before_agent_start'
  | 'agent_end'
  | 'before_compaction'
  | 'after_compaction'
  | 'message_received'
  | 'message_sending'
  | 'message_sent'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'session_start'
  | 'session_end'
  | 'gateway_start'
  | 'gateway_stop';

export interface HookEntry {
  pluginId: string;
  event: HookEvent;
  handler: (context: unknown) => Promise<unknown>;
  priority: number;
}

export class HookExecutor {
  private hooks: HookEntry[] = [];

  /**
   * Register a hook
   */
  register(entry: HookEntry): void {
    this.hooks.push(entry);
  }

  /**
   * Unregister all hooks for a plugin
   */
  unregister(pluginId: string): void {
    this.hooks = this.hooks.filter((h) => h.pluginId !== pluginId);
  }

  /**
   * Execute hooks for an event
   * Hooks run in order of priority (highest first)
   * Each hook receives the result of the previous hook
   */
  async execute(event: HookEvent, context: unknown): Promise<unknown> {
    const eventHooks = this.hooks
      .filter((h) => h.event === event)
      .sort((a, b) => b.priority - a.priority); // Highest priority first

    let result = context;

    for (const hook of eventHooks) {
      try {
        result = await hook.handler(result);
      } catch (error) {
        console.error(
          `Error executing hook for event ${event} in plugin ${hook.pluginId}:`,
          error
        );
        // Continue with other hooks
      }
    }

    return result;
  }

  /**
   * Get all hooks for a specific event
   */
  getHooks(event: HookEvent): HookEntry[] {
    return this.hooks
      .filter((h) => h.event === event)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Clear all hooks
   */
  clear(): void {
    this.hooks = [];
  }
}
