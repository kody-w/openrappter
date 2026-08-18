import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DreamAgent } from '../DreamAgent.js';

/**
 * A blank `stale_days` must not delete every memory.
 *
 * Both numeric parameters were read with `??`, which defaults only on `null`
 * and `undefined`. An empty string passes straight through, and both uses
 * coerce it to zero:
 *
 *     stale_days: ""            ->  "" * 86400000 === 0   -> every memory stale
 *     similarity_threshold: ""  ->  sim >= "" is true      -> every pair merges
 *
 * Measured against the built agent before the fix, over a store holding one
 * memory from 2020 and one from the same day:
 *
 *     stale_days=30  -> pruned 1  ["a 2020 fact"]
 *     stale_days=""  -> pruned 2  ["a 2020 fact","a fact from today"]
 *
 * `prune` and `dream` both write the result back, so that is permanent. A blank
 * form field, or an unset argument forwarded as `""`, is enough to reach it.
 *
 * Every test here runs against an isolated HOME. The agent reads
 * `~/.openrappter/memory.json` directly, and a test suite must not be able to
 * touch the operator's real memories — least of all one about deleting them.
 */

let home = '';
let previousHome: string | undefined;

async function writeMemories(): Promise<void> {
  await fs.mkdir(path.join(home, '.openrappter'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.openrappter', 'memory.json'),
    JSON.stringify({
      old: {
        message: 'a 2020 fact',
        timestamp: '2020-01-01T00:00:00.000Z',
        accessed: 0,
        importance: 1,
      },
      fresh: {
        message: 'a fact from today',
        // A full minute ago, not `now`: written and read inside the same
        // millisecond its age is exactly 0, and `age > 0` is false, which made
        // the stale_days: 0 case pass or fail on sub-millisecond timing.
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        accessed: 0,
        importance: 1,
      },
    }),
  );
}

async function prune(staleDays: unknown): Promise<string[]> {
  const raw = await new DreamAgent().perform({
    action: 'prune',
    stale_days: staleDays,
    dry_run: true,
  });
  const parsed = JSON.parse(raw) as { pruned?: string[] };
  return parsed.pruned ?? [];
}

describe('DreamAgent numeric arguments', () => {
  beforeEach(async () => {
    previousHome = process.env.HOME;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-dream-'));
    process.env.HOME = home;
    await writeMemories();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('prunes only what is actually stale', async () => {
    // Anti-vacuity, and the reason the first version of this probe proved
    // nothing: pruning also requires importance <= 2, so a fixture without it
    // is never eligible and every stale_days looks identical.
    expect(await prune(30)).toEqual(['a 2020 fact']);
  });

  it('a blank stale_days does not prune everything', async () => {
    expect(await prune('')).toEqual(['a 2020 fact']);
  });

  it('falls back for values that are not usable numbers', async () => {
    for (const bad of ['', '  ', 'abc', null, undefined, {}, [], Number.NaN]) {
      expect(await prune(bad), JSON.stringify(bad) ?? 'undefined').toEqual([
        'a 2020 fact',
      ]);
    }
  });

  it('still honours a real number, including zero', async () => {
    // Zero from a caller who typed it is a request, not an accident, and must
    // keep working -- the fix rejects unusable values, it does not clamp away
    // deliberate ones.
    expect((await prune(0)).sort()).toEqual(['a 2020 fact', 'a fact from today']);
    expect(await prune(99999)).toEqual([]);
  });

  it('a numeric string is not silently trusted', async () => {
    // "7" would coerce to a working number, but accepting it means the same
    // path accepts "" — so strings fall back regardless.
    expect(await prune('7')).toEqual(['a 2020 fact']);
  });
});
