/**
 * Content chunking utilities for memory system
 */

import { createHash } from 'crypto';

import type { ChunkOptions } from './types.js';

const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_OVERLAP = 50;

/**
 * Split content into overlapping chunks
 */
export function chunkContent(
  content: string,
  options: ChunkOptions = {}
): string[] {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  // Empty content is no content. Returning [''] made an empty memory chunk,
  // which the Python chunker has never produced.
  if (content.length === 0) {
    return [];
  }
  if (content.length <= chunkSize) {
    return [content];
  }

  const chunks: string[] = [];
  // A step of zero or less never advances. With `overlap >= chunkSize` — or a
  // chunkSize of zero — the loop below ran forever, appending a chunk each
  // time, until the process ran out of memory. Both values come straight from
  // MemoryManagerOptions, so a caller could hang the runtime by configuring
  // them. The Python chunker has clamped this since it was written:
  //
  //     step = max(1, chunk_size - overlap)
  const step = Math.max(1, chunkSize - overlap);

  for (let i = 0; i < content.length; i += step) {
    const chunk = content.slice(i, i + chunkSize);
    if (chunk.trim()) {
      chunks.push(chunk);
    }
    // Stop if we've captured the end
    if (i + chunkSize >= content.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Generate a snippet around a match position
 */
export function generateSnippet(
  content: string,
  query: string,
  maxLength: number = 200
): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();

  // Find the first matching term
  const queryTerms = lowerQuery.split(/\s+/).filter(t => t.length > 2);
  let matchPos = -1;

  for (const term of queryTerms) {
    const pos = lowerContent.indexOf(term);
    if (pos !== -1 && (matchPos === -1 || pos < matchPos)) {
      matchPos = pos;
    }
  }

  // Default to start if no match
  if (matchPos === -1) {
    matchPos = 0;
  }

  // Calculate snippet bounds
  const halfLength = Math.floor(maxLength / 2);
  let start = Math.max(0, matchPos - halfLength);
  let end = Math.min(content.length, matchPos + halfLength);

  // Adjust to word boundaries
  if (start > 0) {
    const spacePos = content.indexOf(' ', start);
    if (spacePos !== -1 && spacePos < matchPos) {
      start = spacePos + 1;
    }
  }

  if (end < content.length) {
    const spacePos = content.lastIndexOf(' ', end);
    if (spacePos !== -1 && spacePos > matchPos) {
      end = spacePos;
    }
  }

  let snippet = content.slice(start, end);

  // Add ellipsis
  if (start > 0) {
    snippet = '...' + snippet;
  }
  if (end < content.length) {
    snippet = snippet + '...';
  }

  return snippet;
}

/**
 * Content hash used as the embedding cache key.
 *
 * This was `hash * 31 + char` truncated to 32 bits and then passed through
 * `Math.abs`, which is the classic Java string hash with half its range thrown
 * away. It is not a hash you can key a cache on:
 *
 *     hashContent('Ea') === hashContent('FB')            // '1q4'
 *     hashContent('hello Ea world') === hashContent('hello FB world')
 *
 * The collisions compose, so they survive being embedded in real text rather
 * than only appearing in two-character strings. A collision is silent and
 * wrong in the worst way: `embeddingCache.get(key)` returns the *other*
 * chunk's vector, the provider is never called, and that chunk is then
 * retrieved by similarity to text it does not contain.
 *
 * Beyond the crafted pairs, synthetic chunks began colliding naturally at
 * 42,484 entries — about what the birthday bound predicts once `Math.abs`
 * folds the space to 2^31.
 *
 * SHA-256 costs microseconds next to an embedding call, and the cache is
 * in-memory only, so nothing persisted depends on the old key.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
