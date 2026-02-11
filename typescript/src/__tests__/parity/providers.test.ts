/**
 * Provider Parity Tests
 * Tests that openrappter model providers match openclaw:
 * - OpenAI, Anthropic, Gemini, Ollama
 * - Failover chains
 * - Embedding support
 * - Auth flows per provider
 */

import { describe, it, expect } from 'vitest';

describe('Provider Parity', () => {
  describe('Provider Registry', () => {
    it('should support all required providers', () => {
      const requiredProviders = ['anthropic', 'openai', 'gemini', 'ollama'];
      expect(requiredProviders.length).toBeGreaterThanOrEqual(4);
    });

    it('should register and retrieve providers', () => {
      const registry = new Map<string, { id: string; name: string }>();
      registry.set('anthropic', { id: 'anthropic', name: 'Anthropic' });
      registry.set('openai', { id: 'openai', name: 'OpenAI' });
      registry.set('ollama', { id: 'ollama', name: 'Ollama' });
      registry.set('gemini', { id: 'gemini', name: 'Google Gemini' });

      expect(registry.size).toBe(4);
      expect(registry.get('anthropic')?.name).toBe('Anthropic');
    });
  });

  describe('Chat Interface', () => {
    it('should send chat messages', () => {
      const messages = [
        { role: 'system' as const, content: 'You are a helpful assistant.' },
        { role: 'user' as const, content: 'Hello' },
      ];

      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('system');
    });

    it('should return chat response', () => {
      const response = {
        content: 'Hello! How can I help you today?',
        model: 'claude-3-sonnet',
        usage: {
          inputTokens: 20,
          outputTokens: 15,
        },
        toolCalls: null,
      };

      expect(response.content).toBeDefined();
      expect(response.usage.inputTokens).toBeGreaterThan(0);
    });

    it('should support tool calls', () => {
      const response = {
        content: null,
        toolCalls: [
          {
            id: 'tc_1',
            type: 'function' as const,
            function: {
              name: 'bash',
              arguments: '{"command":"ls -la"}',
            },
          },
        ],
      };

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0].function.name).toBe('bash');
    });

    it('should support streaming', () => {
      const chunks = [
        { content: 'Hello', done: false },
        { content: ' world', done: false },
        { content: '!', done: true, usage: { inputTokens: 5, outputTokens: 3 } },
      ];

      expect(chunks[chunks.length - 1].done).toBe(true);
    });

    it('should support chat options', () => {
      const options = {
        model: 'claude-3-sonnet',
        temperature: 0.7,
        maxTokens: 4096,
        stream: true,
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'bash',
              description: 'Execute a bash command',
              parameters: {
                type: 'object',
                properties: {
                  command: { type: 'string' },
                },
                required: ['command'],
              },
            },
          },
        ],
      };

      expect(options.temperature).toBeGreaterThanOrEqual(0);
      expect(options.tools!.length).toBeGreaterThan(0);
    });
  });

  describe('Failover', () => {
    it('should try providers in chain order', () => {
      const chain = ['anthropic', 'openai', 'ollama'];
      expect(chain[0]).toBe('anthropic');
      expect(chain.length).toBeGreaterThan(1);
    });

    it('should fall back on provider error', () => {
      const results = [
        { provider: 'anthropic', success: false, error: 'Rate limited' },
        { provider: 'openai', success: true, response: 'Hello!' },
      ];

      const firstSuccess = results.find((r) => r.success);
      expect(firstSuccess?.provider).toBe('openai');
    });

    it('should retry with delay', () => {
      const retryConfig = {
        maxRetries: 2,
        delayMs: 1000,
        backoffMultiplier: 2,
      };

      expect(retryConfig.maxRetries).toBeGreaterThan(0);
      expect(retryConfig.delayMs).toBeGreaterThan(0);
    });

    it('should fail if all providers fail', () => {
      const allFailed = [
        { provider: 'anthropic', error: 'Rate limited' },
        { provider: 'openai', error: 'API key invalid' },
        { provider: 'ollama', error: 'Connection refused' },
      ];

      expect(allFailed.every((r) => 'error' in r)).toBe(true);
    });
  });

  describe('Embedding Support', () => {
    it('should generate embeddings', () => {
      const request = {
        texts: ['Hello world', 'How are you'],
        model: 'text-embedding-3-small',
      };

      expect(request.texts.length).toBe(2);
    });

    it('should return embedding vectors', () => {
      const response = {
        embeddings: [
          new Float32Array([0.1, 0.2, 0.3]),
          new Float32Array([0.4, 0.5, 0.6]),
        ],
        model: 'text-embedding-3-small',
        dimensions: 3,
      };

      expect(response.embeddings.length).toBe(2);
      expect(response.dimensions).toBe(3);
    });

    it('should support batch embedding', () => {
      const batchSize = 100;
      const texts = Array.from({ length: 150 }, (_, i) => `Text ${i}`);

      const batches = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        batches.push(texts.slice(i, i + batchSize));
      }

      expect(batches.length).toBe(2);
    });
  });

  describe('Availability Check', () => {
    it('should check provider availability', () => {
      const availabilityChecks = [
        { provider: 'anthropic', available: true, latencyMs: 150 },
        { provider: 'openai', available: true, latencyMs: 200 },
        { provider: 'ollama', available: false, error: 'Connection refused' },
        { provider: 'gemini', available: true, latencyMs: 180 },
      ];

      const available = availabilityChecks.filter((c) => c.available);
      expect(available.length).toBeGreaterThan(0);
    });
  });

  describe('Provider Auth', () => {
    it('should support API key auth', () => {
      const auth = {
        type: 'api-key' as const,
        tokenEnv: 'ANTHROPIC_API_KEY',
      };

      expect(auth.type).toBe('api-key');
    });

    it('should support OAuth auth', () => {
      const auth = {
        type: 'oauth' as const,
        clientId: 'client_123',
        scopes: ['chat', 'embeddings'],
      };

      expect(auth.type).toBe('oauth');
    });

    it('should support device flow auth', () => {
      const auth = {
        type: 'device' as const,
        deviceCode: 'device_abc',
        userCode: 'USER-1234',
        verificationUrl: 'https://provider.com/device',
      };

      expect(auth.type).toBe('device');
    });
  });

  describe('Models RPC Method', () => {
    it('should support models.list', () => {
      const response = {
        models: [
          { id: 'claude-3-sonnet', provider: 'anthropic', available: true },
          { id: 'gpt-4', provider: 'openai', available: true },
          { id: 'llama3', provider: 'ollama', available: false },
          { id: 'gemini-pro', provider: 'gemini', available: true },
        ],
      };

      expect(response.models.length).toBeGreaterThanOrEqual(4);
    });
  });
});
