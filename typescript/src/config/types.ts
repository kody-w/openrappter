import type { z } from 'zod';
import type { openRappterConfigSchema } from './schema.js';
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

/**
 * The shape `loadConfig()` returns — derived from the schema that validates it.
 *
 * This was a hand-written interface listing **6** sections while
 * `openRappterConfigSchema` validated **21**. The loader parses with the
 * schema and returns this type, so fifteen sections were accepted, validated
 * and then invisible: reading `config.security` or `config.network` was a type
 * error, and the only way to reach one was a local cast.
 *
 * That is a structural reason those sections are read by nothing (#219, #235),
 * not a coincidence — and `security/audit.ts` had to cast to see `browser`.
 *
 * Deriving it means the two cannot drift again: adding a section to the schema
 * adds it here.
 */
export type OpenRappterConfig = z.infer<typeof openRappterConfigSchema>;

export interface ConfigWatcherOptions {
  path: string;
  debounceMs?: number;
  onReload?: (config: OpenRappterConfig) => void;
  onError?: (error: Error) => void;
}
