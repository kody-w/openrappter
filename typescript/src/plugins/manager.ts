/**
 * Plugin Manager
 *
 * Manages the full plugin lifecycle:
 *   - load()       — discover all plugins in pluginDir and initialize them
 *   - enable(name) — activate a loaded plugin (calls onEnable hook)
 *   - disable(name)— deactivate a plugin (calls onDisable hook)
 *   - getPlugin(name)  — get a PluginRecord by name
 *   - listPlugins()    — list all known plugins
 *   - uninstall(name)  — disable then remove from the registry
 *   - registerPlugin() — register a plugin directly (used by tests and loaders)
 *
 * Events emitted (extends EventEmitter):
 *   - "plugin:loaded"   (name: string, record: PluginRecord)
 *   - "plugin:enabled"  (name: string, record: PluginRecord)
 *   - "plugin:disabled" (name: string, record: PluginRecord)
 *   - "plugin:uninstalled" (name: string)
 *   - "plugin:error"    (name: string, error: Error)
 */

import { EventEmitter } from 'events';
import { createPluginContext } from './sdk.js';
import { SecurePluginLoader } from './loader.js';
import type { PluginContext } from './sdk.js';

// ---------------------------------------------------------------------------
// Plugin module interface (what plugins export as default)
// ---------------------------------------------------------------------------

export interface PluginModule {
  /** Called once when the plugin is first loaded */
  initialize?: (ctx: PluginContext) => Promise<void> | void;
  /** Called when the plugin is enabled */
  onEnable?: () => Promise<void> | void;
  /** Called when the plugin is disabled */
  onDisable?: () => Promise<void> | void;
  /** Called when the plugin is unloaded/uninstalled */
  onUnload?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// PluginRecord — the runtime representation of a loaded plugin
// ---------------------------------------------------------------------------

export interface PluginRecord {
  /** Manifest name */
  name: string;
  /** Semver version */
  version: string;
  /** Entry file path (relative) */
  entry: string;
  /** Whether the plugin is currently active */
  enabled: boolean;
  /** Error message if last enable/disable failed */
  error?: string;
  /** The resolved plugin module */
  module: PluginModule;
  /** The SDK context given to this plugin */
  context?: PluginContext;
}

// ---------------------------------------------------------------------------
// Internal registration shape (used by registerPlugin)
// ---------------------------------------------------------------------------

export interface PluginRegistrationInput {
  name: string;
  version: string;
  entry: string;
  /** The raw module object. Pass { default: { ... } } to simulate a default export. */
  _module: { default?: PluginModule } & Record<string, unknown>;
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Manager config
// ---------------------------------------------------------------------------

export interface PluginManagerConfig {
  /** Root directory scanned for plugin sub-directories */
  pluginDir: string;
  /** Config values keyed by plugin name, passed to each plugin's ctx */
  pluginConfigs?: Record<string, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// PluginManager
// ---------------------------------------------------------------------------

export class PluginManager extends EventEmitter {
  private readonly config: PluginManagerConfig;
  private readonly loader: SecurePluginLoader;
  private readonly plugins = new Map<string, PluginRecord>();

  constructor(config: PluginManagerConfig) {
    super();
    this.config = config;
    this.loader = new SecurePluginLoader({ pluginDir: config.pluginDir });
  }

  // ---- Filesystem-based loading -------------------------------------------

  /**
   * Discover all plugins in pluginDir and load them.
   * Errors in individual plugins are captured and emitted as "plugin:error".
   */
  async load(): Promise<void> {
    const manifests = await this.loader.discoverPlugins();

    for (const manifest of manifests) {
      try {
        const loaded = await this.loader.loadPluginFromPath(
          `${this.config.pluginDir}/${manifest.name}`
        );
        if (!loaded) continue;

        const pluginConfig = this.config.pluginConfigs?.[manifest.name] ?? {};
        const ctx = createPluginContext(manifest.name, pluginConfig);
        const pluginModule: PluginModule =
          (loaded.module['default'] as PluginModule) ?? (loaded.module as unknown as PluginModule);

        if (pluginModule.initialize) {
          await pluginModule.initialize(ctx);
        }

        const record: PluginRecord = {
          name: manifest.name,
          version: manifest.version,
          entry: manifest.entry,
          enabled: false,
          module: pluginModule,
          context: ctx,
        };

        this.plugins.set(manifest.name, record);
        this.emit('plugin:loaded', manifest.name, record);
      } catch (err) {
        this.emit('plugin:error', manifest.name, err as Error);
      }
    }
  }

  // ---- Programmatic registration (for tests and in-process plugins) --------

  /**
   * Register a plugin directly without touching the filesystem.
   * Useful for testing and for embedding plugins programmatically.
   */
  registerPlugin(input: PluginRegistrationInput): void {
    const pluginModule: PluginModule =
      (input._module['default'] as PluginModule) ?? (input._module as unknown as PluginModule);

    const pluginConfig = input.config ?? this.config.pluginConfigs?.[input.name] ?? {};
    const ctx = createPluginContext(input.name, pluginConfig);

    const record: PluginRecord = {
      name: input.name,
      version: input.version,
      entry: input.entry,
      enabled: false,
      module: pluginModule,
      context: ctx,
    };

    this.plugins.set(input.name, record);
    this.emit('plugin:loaded', input.name, record);
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Enable a plugin. Calls plugin.onEnable() if defined.
   * Idempotent: calling enable on an already-enabled plugin is a no-op.
   *
   * @throws if the plugin is not registered
   */
  async enable(name: string): Promise<void> {
    const record = this.requirePlugin(name);
    if (record.enabled) return;

    try {
      if (record.module.onEnable) {
        await record.module.onEnable();
      }
      record.enabled = true;
      record.error = undefined;
      this.emit('plugin:enabled', name, record);
    } catch (err) {
      record.error = (err as Error).message;
      this.emit('plugin:error', name, err as Error);
      throw err;
    }
  }

  /**
   * Disable a plugin. Calls plugin.onDisable() if defined.
   * Idempotent: calling disable on an already-disabled plugin is a no-op.
   *
   * @throws if the plugin is not registered
   */
  async disable(name: string): Promise<void> {
    const record = this.requirePlugin(name);
    if (!record.enabled) return;

    try {
      if (record.module.onDisable) {
        await record.module.onDisable();
      }
      record.enabled = false;
      record.error = undefined;
      this.emit('plugin:disabled', name, record);
    } catch (err) {
      record.error = (err as Error).message;
      this.emit('plugin:error', name, err as Error);
      throw err;
    }
  }

  /**
   * Remove a plugin from the registry.
   * If the plugin is enabled it will be disabled first (calling onDisable).
   * Then onUnload is called if defined.
   *
   * Returns false when the plugin is not found.
   */
  async uninstall(name: string): Promise<boolean> {
    const record = this.plugins.get(name);
    if (!record) return false;

    if (record.enabled) {
      await this.disable(name);
    }

    if (record.module.onUnload) {
      try {
        await record.module.onUnload();
      } catch {
        // Swallow onUnload errors — we're removing the plugin regardless
      }
    }

    this.plugins.delete(name);
    this.emit('plugin:uninstalled', name);
    return true;
  }

  // ---- Queries -------------------------------------------------------------

  /**
   * Return the PluginRecord for `name`, or undefined if not registered.
   */
  getPlugin(name: string): PluginRecord | undefined {
    return this.plugins.get(name);
  }

  /**
   * Return all registered plugins as an array.
   */
  listPlugins(): PluginRecord[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Return only the plugins that are currently enabled.
   */
  listEnabledPlugins(): PluginRecord[] {
    return this.listPlugins().filter((p) => p.enabled);
  }

  // ---- Private helpers -----------------------------------------------------

  private requirePlugin(name: string): PluginRecord {
    const record = this.plugins.get(name);
    if (!record) {
      throw new Error(`Plugin "${name}" is not registered`);
    }
    return record;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPluginManager(config: PluginManagerConfig): PluginManager {
  return new PluginManager(config);
}
