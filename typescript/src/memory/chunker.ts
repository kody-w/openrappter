/**
 * Content chunking utilities for memory system
 */

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

  if (content.length <= chunkSize) {
    return [content];
  }

  const chunks: string[] = [];
  const step = chunkSize - overlap;

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
 * Compute simple hash for content (for embedding cache)
 */
export function hashContent(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
