/**
 * Plugin Loader
 * Dynamically loads and manages plugins
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import type {
  Plugin,
  PluginAgent,
  PluginTool,
  PluginCommand,
  PluginGatewayMethod,
  PluginManifest,
  PluginState,
  PluginHook,
  PluginHookEvent,
} from './types.js';

export interface PluginLoaderConfig {
  pluginDirs: string[];
  autoEnable?: boolean;
}

export class PluginLoader {
  private config: PluginLoaderConfig;
  private plugins = new Map<string, Plugin>();
  private states = new Map<string, PluginState>();
  private hooks = new Map<PluginHookEvent, Array<{ pluginId: string; hook: PluginHook }>>();

  constructor(config: PluginLoaderConfig) {
    this.config = {
      autoEnable: true,
      ...config,
    };
  }

  /**
   * Discover and load all plugins
   */
  async loadAll(): Promise<void> {
    for (const dir of this.config.pluginDirs) {
      await this.loadFromDirectory(dir);
    }
  }

  /**
   * Load plugins from a directory
   */
  async loadFromDirectory(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const pluginPath = join(dir, entry.name);
          await this.loadPlugin(pluginPath);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to load plugins from ${dir}:`, error);
      }
    }
  }

  /**
   * Load a single plugin
   */
  async loadPlugin(path: string): Promise<Plugin | null> {
    try {
      // Read manifest
      const manifestPath = join(path, 'manifest.json');
      const manifestData = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestData) as PluginManifest;

      // Check version compatibility
      if (!this.isCompatible(manifest)) {
        console.warn(`Plugin ${manifest.id} is not compatible with this version`);
        return null;
      }

      // Load plugin module
      const modulePath = join(path, manifest.main);
      const module = await import(modulePath);
      const plugin: Plugin = module.default ?? module;

      // Merge manifest into plugin
      const fullPlugin: Plugin = {
        ...plugin,
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        license: manifest.license,
        config: manifest.config,
      };

      // Initialize state
      const state: PluginState = {
        id: manifest.id,
        enabled: false,
        loaded: true,
        config: this.getDefaultConfig(manifest.config),
      };

      this.plugins.set(manifest.id, fullPlugin);
      this.states.set(manifest.id, state);

      // Call onLoad hook
      if (fullPlugin.onLoad) {
        await fullPlugin.onLoad();
      }

      // Auto-enable if configured
      if (this.config.autoEnable) {
        await this.enablePlugin(manifest.id);
      }

      console.log(`Loaded plugin: ${manifest.name} v${manifest.version}`);
      return fullPlugin;
    } catch (error) {
      console.error(`Failed to load plugin from ${path}:`, error);
      return null;
    }
  }

  /**
   * Enable a plugin
   */
  async enablePlugin(id: string): Promise<boolean> {
    const plugin = this.plugins.get(id);
    const state = this.states.get(id);

    if (!plugin || !state) {
      throw new Error(`Plugin not found: ${id}`);
    }

    if (state.enabled) {
      return true;
    }

    try {
      // Register hooks
      if (plugin.hooks) {
        for (const hook of plugin.hooks) {
          this.registerHook(id, hook);
        }
      }

      // Call onEnable hook
      if (plugin.onEnable) {
        await plugin.onEnable();
      }

      state.enabled = true;
      state.error = undefined;
      return true;
    } catch (error) {
      state.error = (error as Error).message;
      return false;
    }
  }

  /**
   * Disable a plugin
   */
  async disablePlugin(id: string): Promise<boolean> {
    const plugin = this.plugins.get(id);
    const state = this.states.get(id);

    if (!plugin || !state) {
      throw new Error(`Plugin not found: ${id}`);
    }

    if (!state.enabled) {
      return true;
    }

    try {
      // Unregister hooks
      this.unregisterHooks(id);

      // Call onDisable hook
      if (plugin.onDisable) {
        await plugin.onDisable();
      }

      state.enabled = false;
      return true;
    } catch (error) {
      state.error = (error as Error).message;
      return false;
    }
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(id: string): Promise<boolean> {
    const plugin = this.plugins.get(id);
    const state = this.states.get(id);

    if (!plugin || !state) {
      return false;
    }

    // Disable first
    if (state.enabled) {
      await this.disablePlugin(id);
    }

    // Call onUnload hook
    if (plugin.onUnload) {
      await plugin.onUnload();
    }

    this.plugins.delete(id);
    this.states.delete(id);
    return true;
  }

  /**
   * Get a plugin
   */
  getPlugin(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get plugin state
   */
  getState(id: string): PluginState | undefined {
    return this.states.get(id);
  }

  /**
   * Get all plugins
   */
  getPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all enabled plugins
   */
  getEnabledPlugins(): Plugin[] {
    return this.getPlugins().filter((p) => this.states.get(p.id)?.enabled);
  }

  /**
   * Update plugin config
   */
  setConfig(id: string, config: Record<string, unknown>): void {
    const state = this.states.get(id);
    if (!state) {
      throw new Error(`Plugin not found: ${id}`);
    }
    state.config = { ...state.config, ...config };
  }

  /**
   * Execute hooks for an event
   */
  async executeHooks(event: PluginHookEvent, context: unknown): Promise<unknown> {
    const hooks = this.hooks.get(event) ?? [];

    // Sort by priority
    const sorted = [...hooks].sort((a, b) => {
      const pa = a.hook.priority ?? 0;
      const pb = b.hook.priority ?? 0;
      return pb - pa;
    });

    let result = context;
    for (const { pluginId, hook } of sorted) {
      const state = this.states.get(pluginId);
      if (!state?.enabled) continue;

      try {
        result = await hook.handler(result);
      } catch (error) {
        console.error(`Hook error in plugin ${pluginId}:`, error);
      }
    }

    return result;
  }

  /**
   * Get all agents from plugins
   */
  getAgents(): PluginAgent[] {
    const agents: PluginAgent[] = [];
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.agents) {
        agents.push(...plugin.agents);
      }
    }
    return agents;
  }

  /**
   * Get all tools from plugins
   */
  getTools(): PluginTool[] {
    const tools: PluginTool[] = [];
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.tools) {
        tools.push(...plugin.tools);
      }
    }
    return tools;
  }

  /**
   * Get all commands from plugins
   */
  getCommands(): PluginCommand[] {
    const commands: PluginCommand[] = [];
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.commands) {
        commands.push(...plugin.commands);
      }
    }
    return commands;
  }

  /**
   * Get all gateway methods from plugins
   */
  getGatewayMethods(): PluginGatewayMethod[] {
    const methods: PluginGatewayMethod[] = [];
    for (const plugin of this.getEnabledPlugins()) {
      if (plugin.gatewayMethods) {
        methods.push(...plugin.gatewayMethods);
      }
    }
    return methods;
  }

  // Private methods

  private isCompatible(manifest: PluginManifest): boolean {
    // TODO: Implement version checking
    return true;
  }

  private getDefaultConfig(schema?: Plugin['config']): Record<string, unknown> {
    if (!schema?.properties) return {};

    const defaults: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (prop.default !== undefined) {
        defaults[key] = prop.default;
      }
    }
    return defaults;
  }

  private registerHook(pluginId: string, hook: PluginHook): void {
    let hooks = this.hooks.get(hook.event);
    if (!hooks) {
      hooks = [];
      this.hooks.set(hook.event, hooks);
    }
    hooks.push({ pluginId, hook });
  }

  private unregisterHooks(pluginId: string): void {
    for (const [event, hooks] of this.hooks) {
      this.hooks.set(
        event,
        hooks.filter((h) => h.pluginId !== pluginId)
      );
    }
  }
}

export function createPluginLoader(config: PluginLoaderConfig): PluginLoader {
  return new PluginLoader(config);
}
