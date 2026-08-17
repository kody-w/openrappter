import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENVELOPE_REQUIRED_KEYS } from '../chat-envelope.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VECTORS_DIR = path.join(repoRoot, 'parity_vectors');
const VECTORS_TEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'parity-vectors.test.ts',
);

/**
 * The golden corpus, read by this runtime rather than described by it.
 *
 * `parity-vectors.test.ts` implements PARITY §5.2's fourteen cases from the
 * specification, because when it was written the corpus was marked "PLANNED —
 * not yet committed" and there was nothing to fetch. The corpus has since been
 * committed: fourteen vectors and a `CORPUS.json` manifest sit at the repo
 * root, and `python/tests/test_parity_corpus.py` globs them, recomputes every
 * digest, and fails if the manifest is stale.
 *
 * TypeScript did not open any of them. It opened no file at all — it carried a
 * hand-written list of the fourteen names and its own expectations. Both sides
 * happen to agree today, which is the problem: a corpus that only one runtime
 * reads cannot detect the two runtimes disagreeing, and that is the single
 * thing a parity corpus exists to do. Edit a vector's expected envelope and
 * Python fails while TypeScript passes.
 *
 * These are the checks that make the corpus binding on this runtime too. They
 * deliberately stop short of executing the vectors — the multi-round loop cases
 * need a scripted model harness, which Python has and this package does not,
 * and claiming to run a vector that is not run would be the same defect again.
 */

interface Vector {
  name: string;
  expect?: { envelope_required_keys?: string[] };
}

interface Manifest {
  spec: string;
  vector_count: number;
  corpus_sha256: string;
  vectors: Record<string, string>;
}

function vectorFiles(): string[] {
  return fs
    .readdirSync(VECTORS_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'CORPUS.json')
    .sort();
}

function readVector(file: string): Vector {
  return JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, file), 'utf8')) as Vector;
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(VECTORS_DIR, 'CORPUS.json'), 'utf8')) as Manifest;
}

/**
 * The case names `parity-vectors.test.ts` declares, read from its source.
 *
 * Importing the constant would re-register that file's suite inside this one
 * and run every vector test twice, so the list is parsed instead — the same
 * derive-from-source approach the dormant-module and event-contract guards use.
 */
function declaredCaseNames(): string[] {
  const source = fs.readFileSync(VECTORS_TEST, 'utf8');
  const block = /VECTOR_CASES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
  if (!block) return [];
  return [...block[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]).sort();
}

/**
 * The manifest's canonical form: JSON with sorted keys and no separator spaces.
 *
 * This mirrors Python's `json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)`. `JSON.stringify` cannot sort keys, so the walk is
 * explicit — and the digests are checked against the manifest, which is what
 * proves the two implementations agree rather than merely look similar.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('the shipped parity corpus binds this runtime', () => {
  it('finds the corpus on disk', () => {
    // Anti-vacuity. Every assertion below reads this directory; if the path is
    // wrong they would all pass over an empty list.
    expect(fs.existsSync(VECTORS_DIR), `${VECTORS_DIR} should exist`).toBe(true);
    expect(vectorFiles().length).toBeGreaterThan(10);
  });

  it('names exactly the vectors that ship, in both directions', () => {
    const onDisk = vectorFiles().map((f) => f.replace(/\.json$/, '')).sort();
    const named = declaredCaseNames();

    // Anti-vacuity for the parser: if the regex stopped matching, `named` would
    // be empty and the second assertion below would pass trivially.
    expect(named.length, 'VECTOR_CASES should be parseable from the test source').toBeGreaterThan(10);

    // Two assertions rather than one equality, so the failure says which way
    // the drift went: a vector added and never run, or a case named that no
    // longer exists.
    expect(onDisk.filter((n) => !named.includes(n)), 'shipped but not run by TypeScript').toEqual([]);
    expect(named.filter((n) => !onDisk.includes(n)), 'named by TypeScript but not shipped').toEqual([]);
  });

  it('agrees with every vector about the envelope contract', () => {
    // TypeScript keeps its own ENVELOPE_REQUIRED_KEYS constant and the vectors
    // declare the same list. Nothing tied them together, so they could drift
    // and both sides would keep passing.
    const expected = [...ENVELOPE_REQUIRED_KEYS].sort();
    const disagreements: string[] = [];

    for (const file of vectorFiles()) {
      const declared = readVector(file).expect?.envelope_required_keys;
      if (!declared) continue;
      const sorted = [...declared].sort();
      if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
        disagreements.push(`${file}: ${JSON.stringify(declared)}`);
      }
    }

    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });

  it('reproduces every per-vector digest in the manifest', () => {
    const declared = manifest().vectors;
    const mismatched: string[] = [];
    let checked = 0;

    for (const file of vectorFiles()) {
      const vector = readVector(file);
      const digest = sha256(canonical(vector));
      if (declared[vector.name] !== digest) {
        mismatched.push(`${vector.name}: manifest ${declared[vector.name]} vs computed ${digest}`);
      }
      checked++;
    }

    // Per vector, not on a total: one stale digest is otherwise hidden by the
    // thirteen that still match.
    expect(checked).toBe(vectorFiles().length);
    expect(mismatched, mismatched.join('\n')).toEqual([]);
  });

  it('reproduces the corpus digest, so a stale manifest cannot pass', () => {
    const declared = manifest();
    const lines = Object.keys(declared.vectors)
      .sort()
      .map((name) => `${name} ${declared.vectors[name]}`)
      .join('\n');

    expect(sha256(lines)).toBe(declared.corpus_sha256);
  });

  it('counts the vectors it claims to', () => {
    expect(manifest().vector_count).toBe(vectorFiles().length);
    expect(manifest().spec).toBe('rapp-runtime-parity/1.0');
  });
});
