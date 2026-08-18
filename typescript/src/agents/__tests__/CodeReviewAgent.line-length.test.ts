import { describe, it, expect } from 'vitest';
import { CodeReviewAgent } from '../CodeReviewAgent.js';

/**
 * A blank `maxLineLength` must not make every line too long.
 *
 * The limit was read with `??`, which defaults only on `null` and `undefined`.
 * An empty string passed straight through, and `line.length > ""` coerces the
 * limit to 0 — so every line exceeds it. Measured before the fix, on a file
 * whose longest line is twelve characters:
 *
 *     maxLineLength=120  -> 0 line-length findings, score 100
 *     maxLineLength=""   -> 2 line-length findings, score  90
 *
 * `"abc"` was already safe: it becomes `NaN` and every comparison is false.
 * The plausible input was the broken one, which is what let it sit.
 *
 * The Python agent has always been correct here — `max_len or
 * self._max_line_length` treats `""` and `0` as unusable and falls back — so
 * the same review produced different findings depending on which runtime
 * answered. These tests pin the TypeScript side to Python's behaviour.
 */

const CLEAN = 'const x = 1;\nconst y = 2;\n';

async function lineLengthFindings(maxLineLength: unknown): Promise<number> {
  const raw = await new CodeReviewAgent().execute({
    action: 'review',
    content: CLEAN,
    file: 'sample.ts',
    maxLineLength,
  });
  const parsed = JSON.parse(raw) as { review: { findings: { rule: string }[] } };
  return parsed.review.findings.filter((f) => f.rule === 'line-length').length;
}

describe('CodeReviewAgent line-length limit', () => {
  it('reports nothing for short lines under a real limit', async () => {
    // Anti-vacuity: if the sample ever gained a long line, every assertion
    // below would pass for the wrong reason.
    expect(await lineLengthFindings(120)).toBe(0);
  });

  it('a blank limit does not flag every line', async () => {
    expect(await lineLengthFindings('')).toBe(0);
  });

  it('falls back for anything that is not a usable number', async () => {
    for (const bad of ['', '  ', 'abc', null, undefined, 0, -1, Number.NaN, {}, []]) {
      expect(await lineLengthFindings(bad), JSON.stringify(bad) ?? 'undefined').toBe(0);
    }
  });

  it('still honours a real limit that the content exceeds', async () => {
    // The behaviour that already worked, pinned so the stricter check did not
    // quietly disable the rule.
    expect(await lineLengthFindings(5)).toBe(2);
  });

  it('matches the Python agent, which treats 0 as unusable', async () => {
    // `max_len or self._max_line_length` in code_review_agent.py. A limit of
    // zero is not a request to flag everything; it is an absent limit.
    expect(await lineLengthFindings(0)).toBe(0);
  });
});
