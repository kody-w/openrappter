/**
 * Plugin system types
 */

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;

  // Lifecycle hooks
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  onEnable?: () => Promise<void>;
  onDisable?: () => Promise<void>;

  // Extension points
  agents?: PluginAgent[];
  channels?: PluginChannel[];
  tools?: PluginTool[];
  commands?: PluginCommand[];
  gatewayMethods?: PluginGatewayMethod[];
  hooks?: PluginHook[];

  // Configuration
  config?: PluginConfigSchema;
}

export interface PluginAgent {
  id: string;
  name: string;
  description: string;
  perform: (message: string, context: unknown) => Promise<unknown>;
}

export interface PluginChannel {
  id: string;
  type: string;
  create: (config: unknown) => unknown;
}

export interface PluginTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface PluginCommand {
  name: string;
  description: string;
  usage?: string;
  aliases?: string[];
  execute: (args: string[], context: unknown) => Promise<void>;
}

export interface PluginGatewayMethod {
  name: string;
  handler: (params: unknown, connection: unknown) => Promise<unknown>;
  requiresAuth?: boolean;
}

export interface PluginHook {
  event: PluginHookEvent;
  priority?: number;
  handler: (context: unknown) => Promise<unknown>;
}

export type PluginHookEvent =
  | 'before-tool-call'
  | 'after-tool-call'
  | 'before-agent-run'
  | 'after-agent-run'
  | 'before-message-send'
  | 'after-message-receive'
  | 'on-error';

export interface PluginConfigSchema {
  type: 'object';
  properties: Record<string, PluginConfigProperty>;
  required?: string[];
}

export interface PluginConfigProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  default?: unknown;
  enum?: unknown[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  license?: string;
  main: string;
  config?: PluginConfigSchema;
  dependencies?: Record<string, string>;
  openrappter?: {
    minVersion?: string;
    maxVersion?: string;
  };
}

export interface PluginState {
  id: string;
  enabled: boolean;
  loaded: boolean;
  config: Record<string, unknown>;
  error?: string;
}
