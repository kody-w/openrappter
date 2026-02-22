/**
 * Showcase: Memory Recall
 *
 * Tests MemoryManager: chunking, FTS search, snippets, source filtering, lifecycle.
 * Uses MemoryManager directly (no inline agents needed).
 */

import { describe, it, expect } from 'vitest';
import { MemoryManager } from '../../memory/manager.js';
import { chunkContent, generateSnippet } from '../../memory/chunker.js';

describe('Showcase: Memory Recall', () => {
  describe('Content chunking', () => {
    it('should chunk content into overlapping windows', () => {
      // Create content longer than chunkSize
      const content = 'word '.repeat(200).trim(); // 999 chars
      const chunks = chunkContent(content, { chunkSize: 100, overlap: 20 });

      expect(chunks.length).toBeGreaterThan(1);

      // Check overlap: end of chunk N should share text with start of chunk N+1
      if (chunks.length >= 2) {
        const endOfFirst = chunks[0].slice(-20);
        expect(chunks[1]).toContain(endOfFirst.trim());
      }
    });

    it('should keep short content as single chunk', () => {
      const content = 'short text';
      const chunks = chunkContent(content, { chunkSize: 512 });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(content);
    });
  });

  describe('MemoryManager lifecycle', () => {
    it('should add content and report via getStatus()', async () => {
      const manager = new MemoryManager({ chunkSize: 512 });
      await manager.add('TypeScript is a typed superset of JavaScript', 'workspace', '/docs/ts.md');
      const status = manager.getStatus();
      expect(status.totalChunks).toBeGreaterThan(0);
    });

    it('should remove by source path and reflect in status', async () => {
      const manager = new MemoryManager({ chunkSize: 512 });
      await manager.add('Content A', 'workspace', '/a.md');
      await manager.add('Content B', 'workspace', '/b.md');

      const removed = manager.removeBySourcePath('/a.md');
      expect(removed).toBe(1);

      const remaining = manager.listChunks();
      expect(remaining.every(c => c.sourcePath !== '/a.md')).toBe(true);
    });
  });

  describe('FTS search', () => {
    it('should return relevant results with score > 0', async () => {
      const manager = new MemoryManager({ chunkSize: 512 });
      await manager.add(
        'The AgentGraph executes nodes in topological order with parallel concurrency',
        'workspace',
        '/docs/graph.md',
      );
      await manager.add(
        'The ChannelRegistry manages multiple messaging channels',
        'workspace',
        '/docs/channels.md',
      );

      const results = await manager.searchFts('AgentGraph topological');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].chunk.content).toContain('AgentGraph');
    });

    it('should respect source filtering', async () => {
      const manager = new MemoryManager({ chunkSize: 512 });
      await manager.add('Memory system docs', 'memory', '/mem.md');
      await manager.add('Workspace system docs with memory reference', 'workspace', '/ws.md');

      const results = await manager.searchFts('memory', { sources: ['memory'] });
      for (const r of results) {
        expect(r.chunk.source).toBe('memory');
      }
    });
  });

  describe('Snippet generation', () => {
    it('should generate snippet highlighting query terms', () => {
      const content = 'The quick brown fox jumps over the lazy dog. The fox is very agile and fast.';
      const snippet = generateSnippet(content, 'fox agile', 60);
      expect(snippet).toBeTruthy();
      expect(typeof snippet).toBe('string');
    });
  });

  describe('Clear and reinitialize', () => {
    it('should clear all chunks', async () => {
      const manager = new MemoryManager({ chunkSize: 512 });
      await manager.add('Some content', 'workspace', '/test.md');
      expect(manager.getStatus().totalChunks).toBeGreaterThan(0);

      manager.clear();
      expect(manager.getStatus().totalChunks).toBe(0);
    });
  });
});
