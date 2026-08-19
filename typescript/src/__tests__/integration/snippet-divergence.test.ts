/**
 * `generateSnippet` and its Python twin do not agree, and that is recorded.
 *
 * #68 measured the two implementations disagreeing on most inputs and
 * deliberately did **not** pick a winner: this side trims to word boundaries
 * and reads better, Python backfills so the snippet uses the `maxLength` the
 * caller asked for, and choosing changes output for every existing caller.
 *
 * What the issue asked for instead was that it be *written down*, because
 * `SPEC.md` says nothing about it and "the next person to diff these will file
 * this issue again".
 *
 * `contracts/snippet-divergence.json` records every case with **both** answers.
 * This test asserts the TypeScript column; `python/tests/test_snippet_divergence.py`
 * asserts the other. Neither endorses its side; together they mean the
 * divergence cannot widen without a test failing, and whoever resolves it can
 * see exactly what changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { generateSnippet } from '../../memory/chunker.js';

const CONTRACT = resolve(__dirname, '../../../../contracts/snippet-divergence.json');

interface Case {
  label: string;
  content: string;
  query: string;
  python: string;
  typescript: string;
  agree: boolean;
}

function load(): { max_length: number; cases: Case[] } {
  return JSON.parse(readFileSync(CONTRACT, 'utf-8')) as { max_length: number; cases: Case[] };
}

describe('snippet divergence is recorded, not resolved', () => {
  it('the record is substantial', () => {
    // Guard the guard: an empty table would make everything below pass.
    const { cases, max_length } = load();
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(max_length).toBeGreaterThan(0);
  });

  it('still records a real disagreement', () => {
    // If these ever agree, the record is stale. A contract describing a
    // divergence that no longer exists teaches the next reader something
    // false, so it should fail rather than sit there.
    const disagreements = load().cases.filter((c) => !c.agree);
    expect(
      disagreements.length,
      'the two runtimes now agree — resolve #68 and delete contracts/snippet-divergence.json',
    ).toBeGreaterThan(0);
  });

  it('TypeScript still answers what the record says', () => {
    const { cases, max_length } = load();
    const drifted = cases
      .map((c) => ({ label: c.label, want: c.typescript, got: generateSnippet(c.content, c.query, max_length) }))
      .filter((r) => r.want !== r.got);

    expect(
      drifted,
      'TypeScript snippet output changed. If deliberate, update contracts/snippet-divergence.json',
    ).toEqual([]);
  });
});
