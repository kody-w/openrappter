/**
 * Configuration system types
 */

export type ModelProvider = 'anthropic' | 'openai' | 'gemini' | 'bedrock' | 'ollama' | 'copilot';
export type AuthType = 'api-key' | 'oauth';
export type BindMode = 'loopback' | 'all';
export type AuthMode = 'none' | 'password';
export type MemoryProvider = 'openai' | 'gemini' | 'local';

export interface ModelConfig {
  id: string;
  provider: ModelProvider;
  model: string;
  auth: {
    type: AuthType;
    token_env?: string;
  };
  fallbacks?: string[];
}

export interface AgentConfig {
  id: string;
  name?: string;
  model: string | { primary: string; fallbacks?: string[] };
  workspace?: string;
  skills?: string[];
  sandbox?: { docker?: boolean };
}

export interface ChannelConfig {
  enabled: boolean;
  allowFrom?: string[];
  mentionGating?: boolean;
}

export interface GatewayConfig {
  port: number;
  bind: BindMode;
  auth?: {
    mode: AuthMode;
    password?: string;
  };
}

export interface MemoryConfig {
  provider: MemoryProvider;
  chunkTokens: number;
  chunkOverlap: number;
}

export interface OpenRappterConfig {
  models?: ModelConfig[];
  agents?: {
    list?: AgentConfig[];
    defaults?: Partial<AgentConfig>;
  };
  channels?: Record<string, ChannelConfig>;
  gateway?: GatewayConfig;
  cron?: { enabled: boolean };
  memory?: MemoryConfig;
}

export interface ConfigWatcherOptions {
  path: string;
  debounceMs?: number;
  onReload?: (config: OpenRappterConfig) => void;
  onError?: (error: Error) => void;
}
