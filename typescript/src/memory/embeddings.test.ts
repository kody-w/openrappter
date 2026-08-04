/**
 * `embed` batches with `i += this.batchSize`, and `batchSize` is a plain
 * constructor option with no validation.
 *
 * At zero the loop never advances and spins forever without producing
 * anything. Below zero the index walks backwards, away from the termination
 * check, while `results` keeps growing — so the process dies instead of
 * hanging. Measured with a bounded reproduction of the same loop over 50
 * inputs:
 *
 *     batchSize  20 -> 50 results
 *     batchSize   1 -> 50 results
 *     batchSize   0 -> did not terminate (0 results, pure spin)
 *     batchSize  -5 -> did not terminate (45 results and climbing)
 *
 * This is the same defect as the memory chunker's unguarded step (#65), in a
 * second file, reached the same way: a size taken from caller options and used
 * directly as a loop increment.
 */
import { describe, it, expect } from 'vitest';
import { OpenAIEmbeddingProvider } from './embeddings.js';

describe('OpenAIEmbeddingProvider batch size', () => {
  it.each([0, -1, -20, 1.5, NaN, Infinity])('refuses a batchSize of %s', (batchSize) => {
    expect(() => new OpenAIEmbeddingProvider({ batchSize }))
      .toThrow(/batchSize must be a positive integer/);
  });

  it.each([1, 5, 20, 1000])('accepts a batchSize of %s', (batchSize) => {
    expect(() => new OpenAIEmbeddingProvider({ batchSize })).not.toThrow();
  });

  it('defaults to a usable batch size', () => {
    expect(() => new OpenAIEmbeddingProvider()).not.toThrow();
  });

  it('embeds every input exactly once across batch boundaries', async () => {
    // Positive control: the guard above would also be satisfied by a provider
    // that refused everything, or one that dropped inputs.
    const texts = Array.from({ length: 50 }, (_, i) => `text-${i}`);

    for (const batchSize of [1, 7, 20, 100]) {
      const provider = new OpenAIEmbeddingProvider({ batchSize, dimensions: 3 });
      const vectors = await provider.embed(texts);

      expect(vectors, `batchSize ${batchSize}`).toHaveLength(texts.length);
      for (const vector of vectors) expect(vector).toHaveLength(3);
    }
  });

  it('returns nothing for no input', async () => {
    expect(await new OpenAIEmbeddingProvider({ dimensions: 3 }).embed([])).toEqual([]);
  });
});
