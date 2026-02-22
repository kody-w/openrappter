/**
 * Plugin API
 * Provides interface for plugins to interact with the system
 */

export interface PluginAPI {
  registerAgent(agent: unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(cmd: unknown): void;
  registerGatewayMethod(method: unknown): void;
  registerHook(event: string, handler: unknown, priority?: number): void;
  registerProvider(provider: unknown): void;
  registerHttpHandler(route: string, handler: unknown): void;
  getConfig(): Record<string, unknown>;
  setConfig(key: string, value: unknown): void;
  getLogger(): {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  emitEvent(event: string, payload: unknown): void;
}

/**
 * Create a PluginAPI instance for a specific plugin
 */
export function createPluginAPI(pluginId: string, _loader: unknown): PluginAPI {
  return {
    registerAgent(agent: unknown): void {
      // Implementation would use loader to register the agent
      console.log(`[${pluginId}] Registering agent:`, agent);
    },

    registerTool(tool: unknown): void {
      console.log(`[${pluginId}] Registering tool:`, tool);
    },

    registerCommand(cmd: unknown): void {
      console.log(`[${pluginId}] Registering command:`, cmd);
    },

    registerGatewayMethod(method: unknown): void {
      console.log(`[${pluginId}] Registering gateway method:`, method);
    },

    registerHook(event: string, handler: unknown, priority?: number): void {
      console.log(`[${pluginId}] Registering hook for event ${event} with priority ${priority ?? 0}`);
    },

    registerProvider(provider: unknown): void {
      console.log(`[${pluginId}] Registering provider:`, provider);
    },

    registerHttpHandler(route: string, _handler: unknown): void {
      console.log(`[${pluginId}] Registering HTTP handler for route ${route}`);
    },

    getConfig(): Record<string, unknown> {
      // Implementation would retrieve plugin config from loader
      return {};
    },

    setConfig(key: string, value: unknown): void {
      console.log(`[${pluginId}] Setting config ${key}:`, value);
    },

    getLogger() {
      return {
        info(...args: unknown[]): void {
          console.log(`[${pluginId}]`, ...args);
        },
        warn(...args: unknown[]): void {
          console.warn(`[${pluginId}]`, ...args);
        },
        error(...args: unknown[]): void {
          console.error(`[${pluginId}]`, ...args);
        },
      };
    },

    emitEvent(event: string, payload: unknown): void {
      console.log(`[${pluginId}] Emitting event ${event}:`, payload);
    },
  };
}
