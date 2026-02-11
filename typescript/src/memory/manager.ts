/**
 * Memory manager - manages chunks, embeddings, and search
 */

import type {
  MemoryChunk,
  MemorySearchResult,
  MemoryStatus,
  SearchOptions,
  MemorySource,
  EmbeddingProvider,
  MemoryManagerOptions,
} from './types.js';
import { chunkContent, generateSnippet, hashContent } from './chunker.js';

let chunkIdCounter = 0;

export class MemoryManager {
  private chunks: Map<string, MemoryChunk> = new Map();
  private embeddings: Map<string, number[]> = new Map();
  private embeddingCache: Map<string, number[]> = new Map();
  private provider: EmbeddingProvider | null;
  private chunkSize: number;
  private chunkOverlap: number;
  private pendingSync = 0;
  private lastSync?: string;

  constructor(options: MemoryManagerOptions = {}) {
    this.provider = options.embeddingProvider ?? null;
    this.chunkSize = options.chunkSize ?? 512;
    this.chunkOverlap = options.chunkOverlap ?? 50;
  }

  async add(content: string, source: MemorySource, sourcePath: string = '', metadata?: Record<string, unknown>): Promise<string> {
    const chunks = chunkContent(content, {
      chunkSize: this.chunkSize,
      overlap: this.chunkOverlap,
    });

    const ids: string[] = [];

    for (const chunkText of chunks) {
      const id = `mem_${Date.now()}_${++chunkIdCounter}`;
      const chunk: MemoryChunk = {
        id,
        content: chunkText,
        source,
        sourcePath,
        metadata,
        createdAt: new Date().toISOString(),
      };

      this.chunks.set(id, chunk);
      ids.push(id);

      // Generate embedding if provider available
      if (this.provider) {
        const cacheKey = hashContent(chunkText);
        let embedding = this.embeddingCache.get(cacheKey);

        if (!embedding) {
          const [result] = await this.provider.embed([chunkText]);
          embedding = result;
          this.embeddingCache.set(cacheKey, embedding);
        }

        chunk.embedding = embedding;
        this.embeddings.set(id, embedding);
      }
    }

    return ids[0];
  }

  async search(query: string, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const limit = options.limit ?? 10;
    const threshold = options.threshold ?? 0;
    const sources = options.sources;

    let results: MemorySearchResult[] = [];

    // Vector search if provider available
    if (this.provider && this.embeddings.size > 0) {
      const [queryEmbedding] = await this.provider.embed([query]);
      results = this.vectorSearch(queryEmbedding, query, sources);
    }

    // FTS fallback/supplement
    const ftsResults = this.ftsSearch(query, sources);

    // Merge results (hybrid search)
    const merged = this.mergeResults(results, ftsResults);

    // Filter by threshold and limit
    return merged
      .filter(r => r.score >= threshold)
      .slice(0, limit);
  }

  async searchFts(query: string, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const limit = options.limit ?? 10;
    const sources = options.sources;

    return this.ftsSearch(query, sources).slice(0, limit);
  }

  remove(id: string): boolean {
    const existed = this.chunks.delete(id);
    this.embeddings.delete(id);
    return existed;
  }

  removeBySourcePath(sourcePath: string): number {
    let removed = 0;
    for (const [id, chunk] of this.chunks) {
      if (chunk.sourcePath === sourcePath) {
        this.chunks.delete(id);
        this.embeddings.delete(id);
        removed++;
      }
    }
    return removed;
  }

  getStatus(): MemoryStatus {
    return {
      totalChunks: this.chunks.size,
      indexedChunks: this.embeddings.size,
      pendingSync: this.pendingSync,
      lastSync: this.lastSync,
    };
  }

  getChunk(id: string): MemoryChunk | undefined {
    return this.chunks.get(id);
  }

  listChunks(source?: MemorySource): MemoryChunk[] {
    const all = Array.from(this.chunks.values());
    if (source) {
      return all.filter(c => c.source === source);
    }
    return all;
  }

  clear(): void {
    this.chunks.clear();
    this.embeddings.clear();
  }

  private vectorSearch(queryEmbedding: number[], query: string, sources?: MemorySource[]): MemorySearchResult[] {
    const results: MemorySearchResult[] = [];

    for (const [id, embedding] of this.embeddings) {
      const chunk = this.chunks.get(id);
      if (!chunk) continue;
      if (sources && !sources.includes(chunk.source)) continue;

      const score = this.cosineSimilarity(queryEmbedding, embedding);
      results.push({
        chunk,
        score,
        snippet: generateSnippet(chunk.content, query),
      });
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private ftsSearch(query: string, sources?: MemorySource[]): MemorySearchResult[] {
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (queryTerms.length === 0) return [];

    const results: MemorySearchResult[] = [];

    for (const chunk of this.chunks.values()) {
      if (sources && !sources.includes(chunk.source)) continue;

      const contentLower = chunk.content.toLowerCase();
      let matchCount = 0;

      for (const term of queryTerms) {
        if (contentLower.includes(term)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        const score = matchCount / queryTerms.length;
        results.push({
          chunk,
          score,
          snippet: generateSnippet(chunk.content, query),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  private mergeResults(vectorResults: MemorySearchResult[], ftsResults: MemorySearchResult[]): MemorySearchResult[] {
    const merged = new Map<string, MemorySearchResult>();
    const vectorWeight = 0.7;
    const ftsWeight = 0.3;

    for (const r of vectorResults) {
      merged.set(r.chunk.id, { ...r, score: r.score * vectorWeight });
    }

    for (const r of ftsResults) {
      const existing = merged.get(r.chunk.id);
      if (existing) {
        existing.score += r.score * ftsWeight;
      } else {
        merged.set(r.chunk.id, { ...r, score: r.score * ftsWeight });
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.score - a.score);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;

    return dotProduct / denom;
  }
}
