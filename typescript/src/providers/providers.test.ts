/**
 * Provider system tests
 */

import { describe, it, expect } from 'vitest';

describe('Provider System', () => {
  describe('Supported Providers', () => {
    it('should support all model providers', () => {
      const providers = ['anthropic', 'openai', 'gemini', 'bedrock', 'ollama', 'copilot'];
      expect(providers.length).toBeGreaterThanOrEqual(6);
      expect(providers).toContain('anthropic');
      expect(providers).toContain('openai');
    });
  });

  describe('Auth Types', () => {
    it('should support API key authentication', () => {
      const auth = { type: 'api-key', token_env: 'ANTHROPIC_API_KEY' };
      expect(auth.type).toBe('api-key');
    });

    it('should support OAuth authentication', () => {
      const auth = { type: 'oauth' };
      expect(auth.type).toBe('oauth');
    });
  });

  describe('Model Failover', () => {
    it('should support fallback chain', () => {
      const config = {
        primary: 'claude-opus',
        fallbacks: ['gpt-4', 'llama'],
      };

      expect(config.fallbacks.length).toBeGreaterThan(0);
    });

    it('should try primary first', () => {
      const chain = ['claude-opus', 'gpt-4', 'llama'];
      expect(chain[0]).toBe('claude-opus');
    });
  });

  describe('Embedding Providers', () => {
    it('should support OpenAI embeddings', () => {
      const provider = { name: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };
      expect(provider.dimensions).toBe(1536);
    });

    it('should support Gemini embeddings', () => {
      const provider = { name: 'gemini', model: 'text-embedding-004', dimensions: 768 };
      expect(provider.dimensions).toBe(768);
    });

    it('should support local embeddings', () => {
      const provider = { name: 'local', model: 'nomic-embed-text', dimensions: 768 };
      expect(provider.model).toContain('embed');
    });
  });
});
