/**
 * Memory system types
 */

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export type MemorySource = 'session' | 'workspace' | 'memory';

export interface MemoryChunk {
  id: string;
  content: string;
  source: MemorySource;
  sourcePath: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemorySearchResult {
  chunk: MemoryChunk;
  score: number;
  snippet: string;
}

export interface MemoryStatus {
  totalChunks: number;
  indexedChunks: number;
  pendingSync: number;
  lastSync?: string;
}

export interface SearchOptions {
  limit?: number;
  threshold?: number;
  sources?: MemorySource[];
}

export interface EmbeddingProvider {
  name: string;
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface MemoryManagerOptions {
  dbPath?: string;
  embeddingProvider?: EmbeddingProvider;
  chunkSize?: number;
  chunkOverlap?: number;
}
