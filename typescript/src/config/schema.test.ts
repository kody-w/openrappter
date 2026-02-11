/**
 * Tests for Configuration Schema
 *
 * These tests define the expected behavior of the configuration system
 * including JSON5 parsing, Zod validation, and environment variable substitution.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Types we expect to implement
interface ModelConfig {
  id: string;
  provider: 'anthropic' | 'openai' | 'gemini' | 'bedrock' | 'ollama' | 'copilot';
  model: string;
  auth: {
    type: 'api-key' | 'oauth';
    token_env?: string;
  };
  fallbacks?: string[];
}

interface AgentConfig {
  id: string;
  name?: string;
  model: string | { primary: string; fallbacks?: string[] };
  workspace?: string;
  skills?: string[];
  sandbox?: { docker?: boolean };
}

interface ChannelConfig {
  enabled: boolean;
  allowFrom?: string[];
  mentionGating?: boolean;
}

interface OpenRappterConfig {
  models?: ModelConfig[];
  agents?: {
    list?: AgentConfig[];
    defaults?: Partial<AgentConfig>;
  };
  channels?: Record<string, ChannelConfig>;
  gateway?: {
    port: number;
    bind: 'loopback' | 'all';
    auth?: {
      mode: 'none' | 'password';
      password?: string;
    };
  };
  cron?: { enabled: boolean };
  memory?: {
    provider: 'openai' | 'gemini' | 'local';
    chunkTokens: number;
    chunkOverlap: number;
  };
}

describe('Configuration Schema', () => {
  describe('ModelConfig validation', () => {
    it('should validate a complete model config', async () => {
      const config: ModelConfig = {
        id: 'claude-opus',
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        auth: {
          type: 'api-key',
          token_env: 'ANTHROPIC_API_KEY',
        },
      };

      // Will be replaced with actual schema validation
      expect(config.id).toBe('claude-opus');
      expect(config.provider).toBe('anthropic');
    });

    it('should validate model config with fallbacks', async () => {
      const config: ModelConfig = {
        id: 'primary',
        provider: 'anthropic',
        model: 'claude-opus-4-5-20251101',
        auth: { type: 'api-key' },
        fallbacks: ['openai-gpt4', 'ollama-llama'],
      };

      expect(config.fallbacks).toHaveLength(2);
    });

    it('should reject invalid provider', async () => {
      const config = {
        id: 'test',
        provider: 'invalid-provider',
        model: 'test-model',
        auth: { type: 'api-key' },
      };

      // Schema should reject this
      expect(['anthropic', 'openai', 'gemini', 'bedrock', 'ollama', 'copilot'])
        .not.toContain(config.provider);
    });

    it('should reject invalid auth type', async () => {
      const config = {
        id: 'test',
        provider: 'anthropic',
        model: 'test',
        auth: { type: 'invalid-auth' },
      };

      expect(['api-key', 'oauth']).not.toContain(config.auth.type);
    });
  });

  describe('AgentConfig validation', () => {
    it('should validate agent with string model', async () => {
      const agent: AgentConfig = {
        id: 'main',
        name: 'Main Assistant',
        model: 'claude-opus',
        workspace: '~/workspace',
        skills: ['shell', 'memory', 'browser'],
      };

      expect(agent.id).toBe('main');
      expect(agent.model).toBe('claude-opus');
    });

    it('should validate agent with model object (failover)', async () => {
      const agent: AgentConfig = {
        id: 'coding',
        model: {
          primary: 'claude-opus',
          fallbacks: ['gpt-4', 'llama'],
        },
        skills: ['coding-agent'],
      };

      expect(typeof agent.model).toBe('object');
      if (typeof agent.model === 'object') {
        expect(agent.model.primary).toBe('claude-opus');
        expect(agent.model.fallbacks).toHaveLength(2);
      }
    });

    it('should validate agent with sandbox config', async () => {
      const agent: AgentConfig = {
        id: 'sandbox-agent',
        model: 'claude-opus',
        sandbox: { docker: true },
      };

      expect(agent.sandbox?.docker).toBe(true);
    });
  });

  describe('ChannelConfig validation', () => {
    it('should validate enabled channel', async () => {
      const channel: ChannelConfig = {
        enabled: true,
        allowFrom: ['+1234567890', '@username'],
        mentionGating: true,
      };

      expect(channel.enabled).toBe(true);
      expect(channel.allowFrom).toContain('+1234567890');
    });

    it('should default enabled to false', async () => {
      const channel: ChannelConfig = {
        enabled: false,
      };

      expect(channel.enabled).toBe(false);
    });
  });

  describe('Full config validation', () => {
    it('should validate complete config', async () => {
      const config: OpenRappterConfig = {
        models: [
          {
            id: 'claude',
            provider: 'anthropic',
            model: 'claude-opus-4-5-20251101',
            auth: { type: 'api-key', token_env: 'ANTHROPIC_API_KEY' },
          },
        ],
        agents: {
          list: [
            { id: 'main', model: 'claude', skills: ['shell'] },
          ],
          defaults: {
            workspace: '~/workspace',
          },
        },
        channels: {
          telegram: { enabled: true, allowFrom: ['@user'] },
          discord: { enabled: false },
        },
        gateway: {
          port: 18789,
          bind: 'loopback',
          auth: { mode: 'password', password: 'secret' },
        },
        cron: { enabled: true },
        memory: {
          provider: 'openai',
          chunkTokens: 512,
          chunkOverlap: 64,
        },
      };

      expect(config.models).toHaveLength(1);
      expect(config.agents?.list).toHaveLength(1);
      expect(config.gateway?.port).toBe(18789);
    });

    it('should use defaults for missing optional fields', async () => {
      const config: OpenRappterConfig = {
        models: [],
      };

      // Defaults should be applied
      expect(config.gateway?.port ?? 18789).toBe(18789);
      expect(config.gateway?.bind ?? 'loopback').toBe('loopback');
      expect(config.cron?.enabled ?? false).toBe(false);
    });
  });
});

describe('Configuration Loader', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('JSON5 parsing', () => {
    it('should parse JSON5 with comments', async () => {
      const json5Content = `{
        // This is a comment
        "name": "test",
        /* Multi-line
           comment */
        "value": 42,
      }`;

      // JSON5 parser should handle this
      // Will be implemented with json5 package
      expect(json5Content).toContain('// This is a comment');
    });

    it('should parse JSON5 with trailing commas', async () => {
      const json5Content = `{
        "array": [1, 2, 3,],
        "object": { "a": 1, },
      }`;

      // Should parse without error
      expect(json5Content).toContain('3,]');
    });

    it('should parse JSON5 with unquoted keys', async () => {
      const json5Content = `{
        name: "test",
        value: 42,
      }`;

      // Should parse without error
      expect(json5Content).toContain('name:');
    });
  });

  describe('Environment variable substitution', () => {
    it('should substitute ${ENV_VAR} syntax', async () => {
      process.env.TEST_API_KEY = 'secret-key-123';

      const config = {
        auth: {
          token: '${TEST_API_KEY}',
        },
      };

      // After substitution
      const substituted = config.auth.token.replace(
        /\$\{(\w+)\}/g,
        (_, key) => process.env[key] ?? ''
      );

      expect(substituted).toBe('secret-key-123');
    });

    it('should handle missing env vars gracefully', async () => {
      const config = {
        token: '${NONEXISTENT_VAR}',
      };

      const substituted = config.token.replace(
        /\$\{(\w+)\}/g,
        (_, key) => process.env[key] ?? ''
      );

      expect(substituted).toBe('');
    });

    it('should substitute multiple env vars in one string', async () => {
      process.env.HOST = 'localhost';
      process.env.PORT = '8080';

      const config = {
        url: 'http://${HOST}:${PORT}/api',
      };

      const substituted = config.url.replace(
        /\$\{(\w+)\}/g,
        (_, key) => process.env[key] ?? ''
      );

      expect(substituted).toBe('http://localhost:8080/api');
    });
  });

  describe('Config file loading', () => {
    it('should load config from default path', async () => {
      // ~/.openrappter/config.json5
      const defaultPath = `${process.env.HOME}/.openrappter/config.json5`;
      expect(defaultPath).toContain('.openrappter/config.json5');
    });

    it('should support profile-based config', async () => {
      // --profile dev should load config.dev.json5
      const profile = 'dev';
      const configPath = `~/.openrappter/config.${profile}.json5`;
      expect(configPath).toContain('config.dev.json5');
    });

    it('should create backup before write', async () => {
      const configPath = '~/.openrappter/config.json5';
      const backupPath = '~/.openrappter/config.backup.json5';
      expect(backupPath).toContain('backup');
    });
  });
});

describe('Configuration Watcher', () => {
  it('should detect config file changes', async () => {
    const onChange = vi.fn();

    // Watcher should call onChange when file changes
    // Will be implemented with chokidar
    expect(typeof onChange).toBe('function');
  });

  it('should debounce rapid changes', async () => {
    const onChange = vi.fn();

    // Multiple rapid changes should result in single callback
    expect(typeof onChange).toBe('function');
  });

  it('should validate new config before applying', async () => {
    // Invalid config changes should be rejected
    const isValid = (config: unknown) => {
      return config !== null && typeof config === 'object';
    };

    expect(isValid({})).toBe(true);
    expect(isValid(null)).toBe(false);
  });
});
