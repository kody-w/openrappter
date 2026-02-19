/**
 * Plugins module exports
 *
 * Public surface of the openrappter plugin SDK:
 *   - manifest  — Zod schema for plugin manifests + helpers
 *   - sdk       — createPluginContext() for use inside plugin code
 *   - loader    — SecurePluginLoader for filesystem discovery
 *   - manager   — PluginManager for lifecycle orchestration
 *   - types     — Shared plugin type definitions
 *   - api       — Legacy PluginAPI interface (backwards-compat)
 *   - hooks     — HookExecutor
 *   - providers — PluginProviderRegistry
 *
 * Note: types.ts defines legacy PluginManifest / PluginConfigSchema interfaces
 * which are superseded by the Zod-validated versions in manifest.ts. The
 * manifest.ts versions are authoritative and exported here without aliasing.
 * The legacy types remain accessible via direct import from './types.js'.
 */

// New SDK modules — exported first so their names take precedence
export * from './manifest.js';
export * from './sdk.js';
export * from './loader.js';
export * from './manager.js';

// Legacy modules — exclude names that now conflict with the new manifest.ts
export type {
  Plugin,
  PluginAgent,
  PluginChannel,
  PluginTool,
  PluginCommand,
  PluginGatewayMethod,
  PluginHook,
  PluginHookEvent,
  PluginConfigProperty as LegacyPluginConfigProperty,
  PluginConfigSchema as LegacyPluginConfigSchema,
  PluginManifest as LegacyPluginManifest,
  PluginHttpHandler,
  PluginProvider,
  PluginService,
  PluginState,
} from './types.js';

export * from './api.js';
export * from './hooks.js';
export * from './providers.js';
