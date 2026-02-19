/**
 * Plugin SDK
 *
 * Public API that plugins import to register capabilities with openrappter.
 * This is the primary interface between plugin code and the host system.
 *
 * Usage in a plugin:
 *
 *   export default {
 *     async initialize(ctx) {
 *       ctx.registerTool({ name: 'my-tool', ... });
 *       ctx.registerHook('before_agent_start', async (ctx) => ctx);
 *       ctx.registerRoute('GET', '/api/my-plugin/status', handler);
 *     }
 *   };
 */

import type { HookEvent } from './hooks.js';
import type { PluginTool } from './types.js';

// ---------------------------------------------------------------------------
// Allowed HTTP methods
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

const ALLOWED_METHODS = new Set<HttpMethod>([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

// ---------------------------------------------------------------------------
// Registration descriptors
// ---------------------------------------------------------------------------

export interface ChannelConfig {
  /** Unique channel identifier */
  id: string;
  /** Channel type label (e.g. "webhook", "slack", "discord") */
  type: string;
  /** Factory function that instantiates the channel */
  create: (config: Record<string, unknown>) => unknown;
}

export interface RouteRegistration {
  method: HttpMethod;
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void> | void;
}

export interface HookRegistration {
  event: HookEvent;
  handler: (context: unknown) => Promise<unknown>;
  priority: number;
}

export interface MemoryBackend {
  /** Unique identifier for this backend */
  id: string;
  /** Human-readable name */
  name: string;
  /** Persist a chunk of text with optional metadata */
  store: (content: string, meta?: Record<string, unknown>) => Promise<void>;
  /** Semantic or keyword search */
  search: (query: string, limit?: number) => Promise<Array<{ content: string; score: number }>>;
  /** Remove an entry by id */
  delete: (id: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Accumulated registrations snapshot
// ---------------------------------------------------------------------------

export interface PluginRegistrations {
  channels: ChannelConfig[];
  tools: PluginTool[];
  hooks: HookRegistration[];
  routes: RouteRegistration[];
  memoryBackends: MemoryBackend[];
}

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface PluginLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Plugin context (the object passed to plugin.initialize())
// ---------------------------------------------------------------------------

export interface PluginContext {
  /**
   * Register a messaging channel.
   * The channel becomes available to users in channel configuration.
   */
  registerChannel(config: ChannelConfig): void;

  /**
   * Register an agent tool.
   * The tool becomes invocable by any agent in the system.
   */
  registerTool(tool: PluginTool): void;

  /**
   * Register a lifecycle hook handler.
   * Hooks fire at specific points in agent/message/session processing.
   *
   * @param phase  - One of the supported hook events
   * @param handler - Async function receiving the current context object
   * @param priority - Execution order (higher = earlier). Defaults to 0.
   */
  registerHook(
    phase: HookEvent,
    handler: (context: unknown) => Promise<unknown>,
    priority?: number
  ): void;

  /**
   * Register an HTTP route handler.
   * Routes are mounted under /plugins/<plugin-name>/<path> by default.
   */
  registerRoute(
    method: HttpMethod,
    path: string,
    handler: (req: unknown, res: unknown) => Promise<void> | void
  ): void;

  /**
   * Register a custom memory backend.
   * Users can select this backend in their openrappter config.
   */
  registerMemoryBackend(backend: MemoryBackend): void;

  /**
   * Access the plugin's validated configuration.
   * Values come from the user's config file, validated against configSchema.
   */
  getConfig(): Record<string, unknown>;

  /**
   * Get a namespaced logger for this plugin.
   * Logs are prefixed with [plugin-name] for easy filtering.
   */
  getLogger(): PluginLogger;

  /**
   * Read back all registrations made so far.
   * Useful for testing and for the manager to apply registrations.
   */
  getRegistrations(): PluginRegistrations;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginContext for a specific plugin.
 *
 * @param pluginName - The plugin's manifest name (used for log prefixing)
 * @param config     - The validated config values from the user's settings
 */
export function createPluginContext(
  pluginName: string,
  config: Record<string, unknown>
): PluginContext {
  const registrations: PluginRegistrations = {
    channels: [],
    tools: [],
    hooks: [],
    routes: [],
    memoryBackends: [],
  };

  // ---- validation helpers ----

  function validateChannelConfig(channelConfig: ChannelConfig): void {
    if (!channelConfig.id || typeof channelConfig.id !== 'string' || channelConfig.id.trim() === '') {
      throw new Error(`[${pluginName}] registerChannel: "id" is required and must be a non-empty string`);
    }
    if (!channelConfig.type) {
      throw new Error(`[${pluginName}] registerChannel: "type" is required`);
    }
    if (typeof channelConfig.create !== 'function') {
      throw new Error(`[${pluginName}] registerChannel: "create" must be a function`);
    }
  }

  function validateTool(tool: PluginTool): void {
    if (!tool.name || typeof tool.name !== 'string' || tool.name.trim() === '') {
      throw new Error(`[${pluginName}] registerTool: "name" is required and must be a non-empty string`);
    }
    if (typeof tool.execute !== 'function') {
      throw new Error(`[${pluginName}] registerTool: "execute" must be a function`);
    }
  }

  function validateMemoryBackend(backend: MemoryBackend): void {
    if (!backend.id) {
      throw new Error(`[${pluginName}] registerMemoryBackend: "id" is required`);
    }
    if (typeof backend.store !== 'function') {
      throw new Error(`[${pluginName}] registerMemoryBackend: "store" must be a function`);
    }
    if (typeof backend.search !== 'function') {
      throw new Error(`[${pluginName}] registerMemoryBackend: "search" must be a function`);
    }
    if (typeof backend.delete !== 'function') {
      throw new Error(`[${pluginName}] registerMemoryBackend: "delete" must be a function`);
    }
  }

  function validateRoute(method: string, path: string): void {
    if (!ALLOWED_METHODS.has(method as HttpMethod)) {
      throw new Error(
        `[${pluginName}] registerRoute: "${method}" is not a valid HTTP method. Allowed: ${[...ALLOWED_METHODS].join(', ')}`
      );
    }
    if (!path || !path.startsWith('/')) {
      throw new Error(`[${pluginName}] registerRoute: path must start with "/"`);
    }
  }

  // ---- logger ----

  const logger: PluginLogger = {
    debug: (...args) => console.debug(`[${pluginName}]`, ...args),
    info: (...args) => console.log(`[${pluginName}]`, ...args),
    warn: (...args) => console.warn(`[${pluginName}]`, ...args),
    error: (...args) => console.error(`[${pluginName}]`, ...args),
  };

  // ---- context object ----

  return {
    registerChannel(channelConfig: ChannelConfig): void {
      validateChannelConfig(channelConfig);
      registrations.channels.push(channelConfig);
    },

    registerTool(tool: PluginTool): void {
      validateTool(tool);
      registrations.tools.push(tool);
    },

    registerHook(
      phase: HookEvent,
      handler: (context: unknown) => Promise<unknown>,
      priority = 0
    ): void {
      registrations.hooks.push({ event: phase, handler, priority });
    },

    registerRoute(
      method: HttpMethod,
      path: string,
      handler: (req: unknown, res: unknown) => Promise<void> | void
    ): void {
      validateRoute(method, path);
      registrations.routes.push({ method, path, handler });
    },

    registerMemoryBackend(backend: MemoryBackend): void {
      validateMemoryBackend(backend);
      registrations.memoryBackends.push(backend);
    },

    getConfig(): Record<string, unknown> {
      return config;
    },

    getLogger(): PluginLogger {
      return logger;
    },

    getRegistrations(): PluginRegistrations {
      return {
        channels: [...registrations.channels],
        tools: [...registrations.tools],
        hooks: [...registrations.hooks],
        routes: [...registrations.routes],
        memoryBackends: [...registrations.memoryBackends],
      };
    },
  };
}
