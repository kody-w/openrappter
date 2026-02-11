/**
 * Embedding providers for memory system
 */

import type { EmbeddingProvider } from './types.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly dimensions: number;
  private apiKey: string;
  private batchSize: number;

  constructor(options?: { model?: string; apiKey?: string; dimensions?: number; batchSize?: number }) {
    this.model = options?.model ?? 'text-embedding-3-small';
    this.apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.dimensions = options?.dimensions ?? 1536;
    this.batchSize = options?.batchSize ?? 20;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    // In production, this would call the OpenAI embeddings API
    // POST https://api.openai.com/v1/embeddings
    return texts.map(() => Array(this.dimensions).fill(0).map(() => Math.random() * 2 - 1));
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;

  constructor(options?: { model?: string; dimensions?: number }) {
    this.model = options?.model ?? 'text-embedding-004';
    this.dimensions = options?.dimensions ?? 768;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // In production, this would call the Gemini embeddings API
    return texts.map(() => Array(this.dimensions).fill(0).map(() => Math.random() * 2 - 1));
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model: string;
  readonly dimensions: number;
  private baseUrl: string;

  constructor(options?: { model?: string; dimensions?: number; baseUrl?: string }) {
    this.model = options?.model ?? 'nomic-embed-text';
    this.dimensions = options?.dimensions ?? 768;
    this.baseUrl = options?.baseUrl ?? 'http://localhost:11434';
  }

  async embed(texts: string[]): Promise<number[][]> {
    // In production, this would call the Ollama embeddings API
    return texts.map(() => Array(this.dimensions).fill(0).map(() => Math.random() * 2 - 1));
  }
}

export function createEmbeddingProvider(
  provider: 'openai' | 'gemini' | 'local',
  options?: Record<string, unknown>
): EmbeddingProvider {
  switch (provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(options);
    case 'gemini':
      return new GeminiEmbeddingProvider(options);
    case 'local':
      return new LocalEmbeddingProvider(options);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}
