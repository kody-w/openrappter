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
import { chunkContent, hashContent } from './chunker.js';
import { MemoryManager } from './manager.js';

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


/**
 * The embedding cache was keyed on a 32-bit Java-style string hash passed
 * through `Math.abs`. Collisions are trivial to produce and, worse, silent:
 * the cache hands back the other chunk's vector, the provider is never called,
 * and the chunk is afterwards retrieved by similarity to text it does not
 * contain.
 */
describe('hashContent', () => {
  // Classic 31-multiplier collisions. 'E'(69)*31+'a'(97) === 'F'(70)*31+'B'(66).
  const collisions: Array<[string, string]> = [
    ['Ea', 'FB'],
    ['EaEa', 'FBFB'],
    ['hello Ea world', 'hello FB world'],
    // Found by sweeping synthetic chunk text; the old hash collided here at
    // 42,484 entries, which is roughly the birthday bound for 2^31.
    ['chunk-24862-xxxxx', 'chunk-42484-x'],
  ];

  it.each(collisions)('distinguishes %s from %s', (a, b) => {
    expect(hashContent(a)).not.toBe(hashContent(b));
  });

  it('is deterministic, so the cache still works', () => {
    expect(hashContent('some chunk of text')).toBe(hashContent('some chunk of text'));
  });

  it('handles non-ASCII content', () => {
    expect(hashContent('caf\u00e9 \u{1F600}')).not.toBe(hashContent('cafe'));
    expect(hashContent('caf\u00e9')).toBe(hashContent('caf\u00e9'));
  });
});

describe('embedding cache keying', () => {
  it('does not hand one chunk the embedding of another', async () => {
    // The consequence, end to end. Before the fix 'FB' was given 'Ea's vector
    // and the provider was never called for it.
    const embedded: string[] = [];
    const provider = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(text => {
          embedded.push(text);
          return [text.length, text.charCodeAt(0), embedded.length];
        });
      },
    };

    const memory = new MemoryManager({ embeddingProvider: provider as never });
    const first = await memory.add('Ea', 'note' as never, 'a');
    const second = await memory.add('FB', 'note' as never, 'b');

    const a = await memory.getChunk(first);
    const b = await memory.getChunk(second);

    expect(embedded).toEqual(['Ea', 'FB']);
    expect(a?.embedding).not.toEqual(b?.embedding);
  });

  it('still reuses the cache for identical content', async () => {
    // Positive control: a hash that never collides would also never cache if it
    // were, say, random per call.
    const embedded: string[] = [];
    const provider = {
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map(text => { embedded.push(text); return [1, 2, 3]; });
      },
    };

    const memory = new MemoryManager({ embeddingProvider: provider as never });
    await memory.add('identical text', 'note' as never, 'a');
    await memory.add('identical text', 'note' as never, 'b');

    expect(embedded).toEqual(['identical text']);
  });
});
