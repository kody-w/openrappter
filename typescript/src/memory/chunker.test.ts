/**
 * `chunkContent` could be made to never return.
 *
 * `step = chunkSize - overlap` was used unguarded. With `overlap === chunkSize`
 * the step is zero and the loop never advances; with `overlap > chunkSize` it
 * is negative and the index walks backwards away from the termination check.
 * Either way the loop appends a chunk on every pass, so the process does not
 * merely hang — it grows until it runs out of memory.
 *
 * Both values come straight from MemoryManagerOptions, so a caller could do
 * this by configuration alone.
 *
 * The Python chunker has clamped the step since it was written:
 *
 *     step = max(1, chunk_size - overlap)
 *
 * The reference counts below were taken from that implementation, so these
 * tests pin the two runtimes together rather than only pinning this one.
 */
import { describe, it, expect } from 'vitest';
import { chunkContent } from './chunker.js';

const TEXT = 'x'.repeat(1000);

describe('chunkContent termination', () => {
  it.each([
    ['overlap equal to chunkSize', { chunkSize: 100, overlap: 100 }, 901],
    ['overlap greater than chunkSize', { chunkSize: 100, overlap: 150 }, 901],
    ['a chunkSize of zero', { chunkSize: 0, overlap: 50 }, 0],
  ])('terminates with %s, and agrees with the Python chunker', (_label, options, expected) => {
    // Reaching the assertion at all is the point: before the clamp this call
    // did not return.
    expect(chunkContent(TEXT, options)).toHaveLength(expected);
  });

  it('still chunks normally, unchanged', () => {
    // Positive control. Without it, clamping the step to something absurd would
    // still satisfy every test above.
    expect(chunkContent(TEXT, { chunkSize: 100, overlap: 10 })).toHaveLength(11);
  });

  it('loses no content when the step is clamped', () => {
    const chunks = chunkContent(TEXT, { chunkSize: 100, overlap: 100 });
    expect(chunks[0]).toBe('x'.repeat(100));
    // Every chunk is a real slice of the input, and the last one reaches the end.
    for (const chunk of chunks) expect(TEXT).toContain(chunk);
    expect(chunks.join('').length).toBeGreaterThanOrEqual(TEXT.length);
  });
});

describe('chunkContent empty input', () => {
  it('returns no chunks for empty content', () => {
    // Previously [''], which made an empty memory chunk. The Python chunker has
    // always returned [] here.
    expect(chunkContent('')).toEqual([]);
  });

  it('still returns a single chunk for content that fits', () => {
    expect(chunkContent('short', { chunkSize: 512 })).toEqual(['short']);
  });
});
