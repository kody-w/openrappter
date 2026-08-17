/**
 * Memory System Parity Tests
 *
 * Exercises the real MemoryManager (src/memory/manager.ts). The previous
 * version of this file imported nothing but `vitest`: every test built a local
 * SQL-schema string, session object, or results array and asserted on its own
 * shape, or defined an inline `cosineSimilarity` / chunking / merge function and
 * tested that reimplementation. None of it touched product code, so it passed no
 * matter what the memory system did.
 *
 * What is already covered elsewhere, and deliberately NOT duplicated here:
 *   - chunkContent / hashContent / embedding-cache keying -> memory/chunker.test.ts
 *   - OpenAIEmbeddingProvider batching/validation          -> memory/embeddings.test.ts
 *   - add / getStatus / removeBySourcePath / listChunks()  -> parity/showcase-memory-recall.test.ts
 *   - searchFts (basic + source filter) / clear / snippet  -> parity/showcase-memory-recall.test.ts
 *
 * The real gap both vacuous memory files falsely claimed to cover is
 * MemoryManager.search(): vector ranking, the hybrid vector+FTS merge, and the
 * threshold / limit / source filters. Those are pinned below with a fixed
 * embedding provider so the scores are deterministic — and, per this repo's
 * hard-won lesson, the hybrid test asserts each contributing path independently
 * rather than only a merged total, so a broken vector path or a broken FTS path
 * is caught on its own.
 */

import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../../memory/manager.js';
import type { EmbeddingProvider } from '../../memory/types.js';

/**
 * A provider that returns a fixed vector for each exact text it is asked to
 * embed. Because test contents are shorter than chunkSize they chunk 1:1, so
 * the string the provider sees is exactly the content (and, for queries, the
 * exact query). Unmapped text embeds to the zero vector (cosine 0).
 */
function fixedProvider(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    name: 'fixed',
    model: 'fixed-test',
    dimensions: 3,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => vectors[t] ?? [0, 0, 0]);
    },
  };
}

describe('Memory System Parity', () => {
  describe('Vector search', () => {
    it('ranks chunks by cosine similarity to the query embedding', async () => {
      const provider = fixedProvider({
        'ts rocks': [1, 0, 0],
        'py rocks': [0.8, 0.6, 0], // cosine 0.8 with the query
        'go rocks': [0.6, 0.8, 0], // cosine 0.6 with the query
        qq: [1, 0, 0], // query direction; length 2 => contributes no FTS terms
      });
      const m = new MemoryManager({ chunkSize: 512, embeddingProvider: provider });
      await m.add('ts rocks', 'workspace', '/ts');
      await m.add('py rocks', 'workspace', '/py');
      await m.add('go rocks', 'workspace', '/go');

      // 'qq' has no term longer than 2 chars, so FTS yields nothing and this is
      // a pure vector ranking.
      const results = await m.search('qq');

      expect(results.map((r) => r.chunk.content)).toEqual(['ts rocks', 'py rocks', 'go rocks']);
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);
    });
  });

  describe('Hybrid search (vector + FTS merge)', () => {
    /**
     * Three chunks isolate the three merge paths for the query 'zeta keyword'
     * (vector weight 0.7, FTS weight 0.3):
     *   - 'vonly aaaa'        vector 1.0, no FTS match  -> 1.0*0.7          = 0.70
     *   - 'zeta keyword bbbb' vector 0.0, FTS 2/2=1.0   -> 0.0*0.7 + 1.0*0.3 = 0.30
     *   - 'zeta cccc'         vector 1.0, FTS 1/2=0.5   -> 1.0*0.7 + 0.5*0.3 = 0.85
     */
    async function hybridManager(): Promise<MemoryManager> {
      const provider = fixedProvider({
        'vonly aaaa': [1, 0, 0],
        'zeta keyword bbbb': [0, 1, 0],
        'zeta cccc': [1, 0, 0],
        'zeta keyword': [1, 0, 0], // the query
      });
      const m = new MemoryManager({ chunkSize: 512, embeddingProvider: provider });
      await m.add('vonly aaaa', 'workspace', '/v');
      await m.add('zeta keyword bbbb', 'workspace', '/f');
      await m.add('zeta cccc', 'workspace', '/b');
      return m;
    }

    it('scores each path independently, not just the combined total', async () => {
      const m = await hybridManager();
      const results = await m.search('zeta keyword');
      const score = new Map(results.map((r) => [r.chunk.content, r.score]));

      // Vector-only path: exercises the 0.7 vector weight alone.
      expect(score.get('vonly aaaa')).toBeCloseTo(0.7, 5);
      // FTS-only path (vector cosine is 0): exercises the 0.3 FTS weight alone.
      expect(score.get('zeta keyword bbbb')).toBeCloseTo(0.3, 5);
      // Both paths add: 1.0*0.7 + 0.5*0.3.
      expect(score.get('zeta cccc')).toBeCloseTo(0.85, 5);
    });

    it('sorts merged results by descending score', async () => {
      const m = await hybridManager();
      const results = await m.search('zeta keyword');
      expect(results.map((r) => r.chunk.content)).toEqual([
        'zeta cccc', // 0.85
        'vonly aaaa', // 0.70
        'zeta keyword bbbb', // 0.30
      ]);
    });

    it('drops results below the score threshold', async () => {
      const m = await hybridManager();
      const results = await m.search('zeta keyword', { threshold: 0.5 });
      const contents = results.map((r) => r.chunk.content);

      expect(contents).toContain('zeta cccc'); // 0.85 stays
      expect(contents).toContain('vonly aaaa'); // 0.70 stays
      expect(contents).not.toContain('zeta keyword bbbb'); // 0.30 filtered out
      expect(results).toHaveLength(2);
    });

    it('caps the number of results at the requested limit', async () => {
      const m = await hybridManager();
      const results = await m.search('zeta keyword', { limit: 1 });
      expect(results).toHaveLength(1);
      expect(results[0].chunk.content).toBe('zeta cccc'); // the highest scorer
    });
  });

  describe('Source filtering in search', () => {
    it('excludes chunks whose source is not in the requested set', async () => {
      const provider = fixedProvider({
        'zeta alpha': [1, 0, 0],
        'zeta alpha extra': [1, 0, 0],
      });
      const m = new MemoryManager({ chunkSize: 512, embeddingProvider: provider });
      // Both chunks would match the query strongly on both vector and FTS; only
      // the source filter should keep the workspace one out.
      await m.add('zeta alpha', 'memory', '/mem');
      await m.add('zeta alpha extra', 'workspace', '/ws');

      const results = await m.search('zeta alpha', { sources: ['memory'] });

      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.chunk.source === 'memory')).toBe(true);
      expect(results.some((r) => r.chunk.sourcePath === '/ws')).toBe(false);
    });
  });

  describe('Removal by id', () => {
    it('removes the chunk, cleans up its embedding, and reports whether it existed', async () => {
      const provider = fixedProvider({ 'solo doc': [1, 0, 0] });
      const m = new MemoryManager({ chunkSize: 512, embeddingProvider: provider });
      const id = await m.add('solo doc', 'workspace', '/solo');

      expect(m.getStatus()).toMatchObject({ totalChunks: 1, indexedChunks: 1 });

      expect(m.remove(id)).toBe(true);
      expect(m.remove(id)).toBe(false); // already gone
      expect(m.getChunk(id)).toBeUndefined();
      expect(m.getStatus()).toMatchObject({ totalChunks: 0, indexedChunks: 0 });
    });
  });

  describe('listChunks by source', () => {
    it('returns only chunks of the requested source', async () => {
      const m = new MemoryManager({ chunkSize: 512 });
      await m.add('session note', 'session', '/s');
      await m.add('workspace note', 'workspace', '/w');
      await m.add('memory note', 'memory', '/m');

      expect(m.listChunks()).toHaveLength(3);
      expect(m.listChunks('workspace').map((c) => c.content)).toEqual(['workspace note']);
      expect(m.listChunks('session').map((c) => c.source)).toEqual(['session']);
    });
  });

  describe('getChunk', () => {
    it('returns the stored chunk with its content and source', async () => {
      const m = new MemoryManager({ chunkSize: 512 });
      const id = await m.add('a retrievable fact', 'memory', '/fact');
      const chunk = m.getChunk(id);
      expect(chunk?.content).toBe('a retrievable fact');
      expect(chunk?.source).toBe('memory');
      expect(m.getChunk('no-such-id')).toBeUndefined();
    });
  });
});
