/**
 * Provider Parity Tests
 *
 * Exercises the real ProviderRegistry (src/providers/registry.ts) — registration,
 * lookup, availability filtering, and chat failover. The previous version of this
 * file built literal arrays/objects and asserted on their own shape (e.g.
 * `const chain = ['anthropic','openai','ollama']; expect(chain[0]).toBe('anthropic')`),
 * so it passed no matter what the registry did. These tests register real and
 * mock providers and assert on the registry's behaviour.
 */

import { describe, it, expect } from 'vitest';
import { ProviderRegistry, createDefaultRegistry } from '../../providers/registry.js';
import type { LLMProvider, ProviderResponse, Message } from '../../providers/types.js';

function mockProvider(
  id: string,
  behaviour: { response?: Partial<ProviderResponse>; throws?: boolean; available?: boolean }
): LLMProvider {
  return {
    id,
    name: id,
    async chat(): Promise<ProviderResponse> {
      if (behaviour.throws) throw new Error(`${id} failed`);
      return { content: `from-${id}`, tool_calls: null, ...behaviour.response };
    },
    async isAvailable(): Promise<boolean> {
      return behaviour.available ?? true;
    },
  };
}

const messages: Message[] = [{ role: 'user', content: 'hi' }];

describe('Provider Parity', () => {
  describe('Default registry', () => {
    it('registers the built-in providers', () => {
      const registry = createDefaultRegistry();
      expect(registry.list().sort()).toEqual(['anthropic', 'ollama', 'openai']);
      expect(registry.has('anthropic')).toBe(true);
      expect(registry.get('openai')?.id).toBe('openai');
    });

    it('does not report a provider that was never registered', () => {
      const registry = createDefaultRegistry();
      expect(registry.has('gemini')).toBe(false);
      expect(registry.get('gemini')).toBeUndefined();
    });
  });

  describe('Registration and lookup', () => {
    it('registers and retrieves a provider by id', () => {
      const registry = new ProviderRegistry();
      const provider = mockProvider('custom', {});
      registry.register(provider);

      expect(registry.get('custom')).toBe(provider);
      expect(registry.has('custom')).toBe(true);
      expect(registry.list()).toContain('custom');
    });

    it('replaces a provider registered under the same id', () => {
      const registry = new ProviderRegistry();
      registry.register(mockProvider('dup', { response: { content: 'first' } }));
      registry.register(mockProvider('dup', { response: { content: 'second' } }));
      expect(registry.list()).toEqual(['dup']);
    });
  });

  describe('Availability filtering', () => {
    it('returns only providers that report themselves available', async () => {
      const registry = new ProviderRegistry();
      registry.register(mockProvider('up', { available: true }));
      registry.register(mockProvider('down', { available: false }));

      const available = await registry.getAvailable();
      expect(available.map((p) => p.id)).toEqual(['up']);
    });
  });

  describe('Chat failover', () => {
    it('falls over to the next provider when the first throws', async () => {
      const registry = new ProviderRegistry();
      registry.register(mockProvider('primary', { throws: true }));
      registry.register(mockProvider('secondary', { response: { content: 'rescued' } }));

      const response = await registry.chatWithFailover(
        ['primary', 'secondary'],
        messages,
        undefined,
        { maxRetries: 0, retryDelayMs: 0 }
      );
      expect(response.content).toBe('rescued');
    });

    it('returns the first provider that succeeds without trying the rest', async () => {
      const registry = new ProviderRegistry();
      registry.register(mockProvider('first', { response: { content: 'first-wins' } }));
      registry.register(mockProvider('second', { response: { content: 'unused' } }));

      const response = await registry.chatWithFailover(
        ['first', 'second'],
        messages,
        undefined,
        { maxRetries: 0, retryDelayMs: 0 }
      );
      expect(response.content).toBe('first-wins');
    });

    it('throws when every provider in the chain fails', async () => {
      const registry = new ProviderRegistry();
      registry.register(mockProvider('only', { throws: true }));

      await expect(
        registry.chatWithFailover(['only'], messages, undefined, { maxRetries: 0, retryDelayMs: 0 })
      ).rejects.toThrow(/All providers failed/);
    });

    it('reports a chain entry that is not registered as a failure', async () => {
      const registry = new ProviderRegistry();
      await expect(
        registry.chatWithFailover(['ghost'], messages, undefined, { maxRetries: 0, retryDelayMs: 0 })
      ).rejects.toThrow(/All providers failed/);
    });
  });
});
