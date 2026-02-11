/**
 * Provider registry with failover support
 */

import type {
  LLMProvider,
  Message,
  ChatOptions,
  ProviderResponse,
  EmbeddingOptions,
  ProviderConfig,
} from './types.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createOllamaProvider } from './ollama.js';

export interface FailoverOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  skipUnavailable?: boolean;
}

const DEFAULT_FAILOVER_OPTIONS: FailoverOptions = {
  maxRetries: 2,
  retryDelayMs: 1000,
  skipUnavailable: true,
};

/**
 * Provider registry for managing multiple LLM providers
 */
export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /**
   * Register a provider
   */
  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Get a provider by ID
   */
  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /**
   * Check if a provider exists
   */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * List all provider IDs
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * List all providers
   */
  listProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get available providers (that are configured and accessible)
   */
  async getAvailable(): Promise<LLMProvider[]> {
    const available: LLMProvider[] = [];
    for (const provider of this.providers.values()) {
      if (await provider.isAvailable()) {
        available.push(provider);
      }
    }
    return available;
  }

  /**
   * Chat with failover across multiple providers
   */
  async chatWithFailover(
    providerChain: string[],
    messages: Message[],
    options?: ChatOptions,
    failoverOptions?: FailoverOptions
  ): Promise<ProviderResponse> {
    const opts = { ...DEFAULT_FAILOVER_OPTIONS, ...failoverOptions };
    const errors: Error[] = [];

    for (const providerId of providerChain) {
      const provider = this.providers.get(providerId);

      if (!provider) {
        errors.push(new Error(`Provider '${providerId}' not found`));
        continue;
      }

      // Skip unavailable providers if configured
      if (opts.skipUnavailable && !(await provider.isAvailable())) {
        errors.push(new Error(`Provider '${providerId}' is not available`));
        continue;
      }

      // Try with retries
      for (let attempt = 0; attempt <= (opts.maxRetries ?? 0); attempt++) {
        try {
          return await provider.chat(messages, options);
        } catch (error) {
          errors.push(error as Error);

          // Don't retry on last attempt
          if (attempt < (opts.maxRetries ?? 0)) {
            await this.delay(opts.retryDelayMs ?? 1000);
          }
        }
      }
    }

    // All providers failed
    const errorMessages = errors.map((e) => e.message).join('; ');
    throw new Error(`All providers failed: ${errorMessages}`);
  }

  /**
   * Embed with failover across multiple providers
   */
  async embedWithFailover(
    providerChain: string[],
    texts: string[],
    options?: EmbeddingOptions,
    failoverOptions?: FailoverOptions
  ): Promise<number[][]> {
    const opts = { ...DEFAULT_FAILOVER_OPTIONS, ...failoverOptions };
    const errors: Error[] = [];

    for (const providerId of providerChain) {
      const provider = this.providers.get(providerId);

      if (!provider) {
        errors.push(new Error(`Provider '${providerId}' not found`));
        continue;
      }

      if (!provider.embed) {
        errors.push(new Error(`Provider '${providerId}' does not support embeddings`));
        continue;
      }

      if (opts.skipUnavailable && !(await provider.isAvailable())) {
        errors.push(new Error(`Provider '${providerId}' is not available`));
        continue;
      }

      for (let attempt = 0; attempt <= (opts.maxRetries ?? 0); attempt++) {
        try {
          return await provider.embed(texts, options);
        } catch (error) {
          errors.push(error as Error);

          if (attempt < (opts.maxRetries ?? 0)) {
            await this.delay(opts.retryDelayMs ?? 1000);
          }
        }
      }
    }

    const errorMessages = errors.map((e) => e.message).join('; ');
    throw new Error(`All embedding providers failed: ${errorMessages}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a registry with default providers
 */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register built-in providers
  registry.register(createAnthropicProvider());
  registry.register(createOpenAIProvider());
  registry.register(createOllamaProvider());

  return registry;
}

/**
 * Create a registry from provider configs
 */
export function createRegistryFromConfigs(configs: ProviderConfig[]): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const config of configs) {
    const apiKey = config.auth.token ?? (config.auth.token_env ? process.env[config.auth.token_env] : undefined);

    let provider: LLMProvider | null = null;

    switch (config.provider) {
      case 'anthropic':
        provider = createAnthropicProvider(apiKey);
        break;
      case 'openai':
        provider = createOpenAIProvider(apiKey);
        break;
      case 'ollama':
        provider = createOllamaProvider();
        break;
      default:
        console.warn(`Unknown provider type: ${config.provider}`);
        continue;
    }

    if (provider) {
      // Override the ID with the config ID
      (provider as { id: string }).id = config.id;
      registry.register(provider);
    }
  }

  return registry;
}
