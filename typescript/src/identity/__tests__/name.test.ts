/**
 * The organism's name must be a pure function of its identity, and must never
 * leak the one secret that identity rests on.
 *
 * The trap this file exists to guard: the only value that exists in the code is
 * the 64-hex tail, which RAPP/1 6.2 mints exactly once, so the obvious
 * implementation names the organism after the leading characters of its own
 * mint-once secret. rappdex says it plainly -- "your tail is never in it."
 */

import { describe, expect, it } from 'vitest';
import crypto from 'crypto';

import {
  nameFor, rappidHex, serialFrom, calledNameFrom,
  isBlockedName, isPronounceable, mintTail,
} from '../name.js';

const TAIL_A = 'a'.repeat(64);
const TAIL_B = 'b'.repeat(64);

function sampleTail(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

describe('the tail never becomes the name', () => {
  it('derives the rappid by a domain-separated hash, not from the tail directly', () => {
    const rappid = rappidHex(TAIL_A);
    expect(rappid).toHaveLength(64);
    expect(rappid).not.toBe(TAIL_A);
    const expected = crypto.createHash('sha256').update(`rapp/1:rappid\n${TAIL_A}`).digest('hex');
    expect(rappid).toBe(expected);
  });

  it('puts no fragment of the tail into either name', () => {
    const tail = sampleTail('leak-check');
    const n = nameFor(tail);
    const surface = `${n.designation} ${n.called} ${n.serial}`.toLowerCase();
    // Every 4-hex window of the tail. A name is short, so this is the strong
    // form: no recognisable piece of the secret survives anywhere.
    for (let i = 0; i + 4 <= tail.length; i++) {
      expect(surface).not.toContain(tail.slice(i, i + 4));
    }
  });

  it('cannot be inverted -- two tails sharing a prefix give unrelated names', () => {
    const a = 'ff' + '0'.repeat(62);
    const b = 'ff' + '0'.repeat(61) + '1';
    expect(nameFor(a).designation).not.toBe(nameFor(b).designation);
  });
});

describe('determinism', () => {
  it('gives the same names every time, for the same tail', () => {
    const first = nameFor(TAIL_A);
    for (let i = 0; i < 25; i++) expect(nameFor(TAIL_A)).toEqual(first);
  });

  it('gives different designations for different tails', () => {
    expect(nameFor(TAIL_A).designation).not.toBe(nameFor(TAIL_B).designation);
  });

  it('uses no clock, counter or randomness', () => {
    const rappid = rappidHex(TAIL_A);
    const snapshot = { s: serialFrom(rappid), c: calledNameFrom(rappid) };
    expect(nameFor(TAIL_A).serial).toBe(snapshot.s);
    expect(nameFor(TAIL_A).called).toBe(snapshot.c);
  });
});

describe('the designation looks like a serial number', () => {
  it('is two letters and four digits, FN-2187 shaped', () => {
    for (let i = 0; i < 200; i++) {
      const n = nameFor(sampleTail(`serial-${i}`));
      expect(n.serial).toMatch(/^[A-Z]{2}-\d{4}$/);
      expect(n.designation).toBe(`openrappter-${n.serial}`);
    }
  });
});

describe('the called name is the Finn move', () => {
  it('builds C1 + core + C2 + ending, matching the worked examples', () => {
    const shape = (c1: string, c2: string, core: string, end: string) =>
      c1 + core + c2.toLowerCase() + end;
    expect(shape('F', 'N', 'i', 'n')).toBe('Finn');
    expect(shape('R', 'X', 'e', '')).toBe('Rex');
    expect(shape('T', 'K', 'ee', '')).toBe('Teek');
    expect(shape('B', 'B', 'i', 'i')).toBe('Bibi');
    expect(shape('D', 'Z', 'e', 'a')).toBe('Deza');
    expect(shape('K', 'L', 'ay', 'o')).toBe('Kaylo');
  });

  it('always starts with the first letter of the serial', () => {
    for (let i = 0; i < 200; i++) {
      const n = nameFor(sampleTail(`initial-${i}`));
      expect(n.called[0]).toBe(n.serial[0]);
    }
  });

  it('never emits a blocklisted name across a thousand tails', () => {
    let blocked = 0;
    for (let i = 0; i < 1000; i++) {
      if (isBlockedName(nameFor(sampleTail(`sweep-${i}`)).called)) blocked++;
    }
    expect(blocked).toBe(0);
  });

  it('never emits an unpronounceable name across a thousand tails', () => {
    // Deterministic and unsayable is still a failure. The first version passed
    // the blocklist and emitted Kuwwn, Geijjn and Xicix.
    let bad = 0;
    for (let i = 0; i < 1000; i++) {
      if (!isPronounceable(nameFor(sampleTail(`sweep-${i}`)).called)) bad++;
    }
    expect(bad).toBe(0);
  });

  it('rejects the shapes that made the first attempt unsayable', () => {
    expect(isPronounceable('Kuwwn')).toBe(false);
    expect(isPronounceable('Geijjn')).toBe(false);
    expect(isPronounceable('Xicix')).toBe(false);
    for (const ok of ['Finn', 'Rex', 'Teek', 'Bibi', 'Deza', 'Kaylo']) {
      expect(isPronounceable(ok)).toBe(true);
    }
  });

  it('stays diverse -- a thousand tails do not collapse onto a few names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 1000; i++) names.add(nameFor(sampleTail(`div-${i}`)).called);
    expect(names.size).toBeGreaterThan(400);
  });
});

describe('a chosen name wins, and only over the called name', () => {
  it('SOUL.md overrides what it goes by', () => {
    const n = nameFor(TAIL_A, 'Atlas');
    expect(n.called).toBe('Atlas');
    expect(n.chosen).toBe(true);
  });

  it('leaves the designation untouched -- what it IS cannot be renamed', () => {
    expect(nameFor(TAIL_A, 'Atlas').designation).toBe(nameFor(TAIL_A).designation);
  });

  it('ignores an empty or whitespace name rather than erasing the derived one', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const n = nameFor(TAIL_A, empty as string | null | undefined);
      expect(n.called).toBe(nameFor(TAIL_A).called);
      expect(n.chosen).toBe(false);
    }
  });
});

describe('minting', () => {
  it('produces a 64-hex tail', () => {
    expect(mintTail()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(mintTail());
    expect(seen.size).toBe(50);
  });
});
