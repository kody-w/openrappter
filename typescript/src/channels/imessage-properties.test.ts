/**
 * Properties of the three functions that stand between an inbound iMessage and
 * the model, checked over generated input rather than chosen examples.
 *
 * The example-based tests elsewhere cover the paths someone thought of. These
 * cover the ones nobody did:
 *
 *   - `normalizeIMessageAddress` decides authorization. If it were not
 *     idempotent, an address stored in its normalised form could normalise
 *     again to something else, and an allowlist comparison would stop meaning
 *     what it did when the entry was written.
 *   - `decodeAttributedBodyHex` parses attacker-adjacent bytes out of the
 *     Messages database. A throw there is a denial of service on inbound mail.
 *   - `chunkIMessageText` must reproduce its input exactly. A chunker that
 *     drops or duplicates text corrupts what the recipient sees, silently.
 *
 * The generator is a seeded LCG, so a failure is reproducible and the suite
 * cannot go flaky. Run at 2,000 cases each; the same properties were checked
 * once at 60,000 / 120,000 / 40,000 with no failures, which is why these are
 * assertions rather than an open question.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeIMessageAddress,
  decodeAttributedBodyHex,
  chunkIMessageText,
} from './imessage.js';

/** Deterministic PRNG, so a failure can be reproduced from the seed alone. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

describe('normalizeIMessageAddress properties', () => {
  const ALPHABET = [
    '+', '1', '5', '0', '9', ' ', '(', ')', '-', '.', '@', 'a', 'K',
    '\u212A', '\u017F', '\u0130', '\uFF11', '\u0660', '\t', '\n', '\u200B',
    'A', '.com', 'icloud',
  ] as const;

  it('is idempotent: a normalised address normalises to itself', () => {
    const random = lcg(0x5EED);
    for (let i = 0; i < 2000; i++) {
      let input = '';
      const length = 1 + Math.floor(random() * 14);
      for (let k = 0; k < length; k++) input += pick(random, ALPHABET);

      const once = normalizeIMessageAddress(input);
      if (once === null) continue;

      expect(normalizeIMessageAddress(once), `input ${JSON.stringify(input)}`).toBe(once);
    }
  });

  it('never throws, whatever it is given', () => {
    const random = lcg(0xC0FFEE);
    for (let i = 0; i < 2000; i++) {
      let input = '';
      const length = Math.floor(random() * 20);
      for (let k = 0; k < length; k++) input += pick(random, ALPHABET);

      expect(() => normalizeIMessageAddress(input)).not.toThrow();
    }
  });

  it('only ever returns an address that passes its own rules', () => {
    // A returned value must be either a lowercase email or an E.164 number.
    // Anything else means the allowlist is comparing against a shape it was
    // never written for.
    //
    // Random tokens almost never land on exactly ten digits, so the seeded
    // cases below are not decoration: without them this test passed while the
    // ten-digit branch returned `001...` instead of `+1...`. A generator that
    // cannot reach a branch does not test it.
    const seeded = [
      '5551234567', '(555) 123-4567', '555-123-4567', '555.123.4567',
      '15551234567', '1 555 123 4567', '+15551234567', '+442079460123',
      'Person.Name@Example.COM', 'a@b.co',
    ];
    const random = lcg(0xBEEF);
    for (let i = 0; i < 2000; i++) {
      let input: string;
      if (i < seeded.length) {
        input = seeded[i];
      } else {
        input = '';
        const length = 1 + Math.floor(random() * 14);
        for (let k = 0; k < length; k++) input += pick(random, ALPHABET);
      }

      const result = normalizeIMessageAddress(input);
      if (result === null) continue;

      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) && result === result.toLowerCase();
      const isPhone = /^\+[1-9]\d{7,14}$/.test(result);
      expect(isEmail || isPhone, `${JSON.stringify(input)} -> ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

describe('decodeAttributedBodyHex properties', () => {
  const MARKER = Buffer.from('NSString').toString('hex');

  it('never throws on malformed or hostile input', () => {
    const random = lcg(0xD00D);
    for (let i = 0; i < 2000; i++) {
      const mode = i % 4;
      let hex: string;
      if (mode === 0) {
        hex = randomHex(random, 1 + (i % 40));
      } else if (mode === 1) {
        hex = MARKER + randomHex(random, 1 + (i % 20));
      } else if (mode === 2) {
        hex = MARKER + '2b' + pick(random, ['81', '82', '83', '7f', '00', 'ff']) + 'ff'.repeat(i % 5);
      } else {
        hex = MARKER + '2b' + randomHex(random, i % 12);
      }

      expect(() => decodeAttributedBodyHex(hex), hex.slice(0, 40)).not.toThrow();
    }
  });

  it('returns a string or null, never anything else', () => {
    const random = lcg(0xFEED);
    for (let i = 0; i < 2000; i++) {
      const result = decodeAttributedBodyHex(MARKER + '2b' + randomHex(random, 1 + (i % 16)));
      expect(result === null || typeof result === 'string').toBe(true);
    }
  });

  function randomHex(random: () => number, bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) out += Math.floor(random() * 256).toString(16).padStart(2, '0');
    return out;
  }
});

describe('chunkIMessageText properties', () => {
  const POOL = [
    'a', '\u{1F600}', '\u{1F468}\u200D\u{1F469}', '\u0301',
    '\u{1F1FA}\u{1F1F8}', '\n', '\u200D', 'x',
  ] as const;

  it('always reproduces its input exactly', () => {
    const random = lcg(0xABCD);
    for (let i = 0; i < 2000; i++) {
      let content = '';
      const pieces = 1 + Math.floor(random() * 12);
      for (let k = 0; k < pieces; k++) content += pick(random, POOL);

      const maxLength = 1 + Math.floor(random() * 6);
      const chunks = chunkIMessageText(content, maxLength);

      expect(chunks.join(''), `${JSON.stringify(content)} @${maxLength}`).toBe(content);
    }
  });

  it('never exceeds the requested length', () => {
    const random = lcg(0x1234);
    for (let i = 0; i < 2000; i++) {
      let content = '';
      const pieces = 1 + Math.floor(random() * 12);
      for (let k = 0; k < pieces; k++) content += pick(random, POOL);

      const maxLength = 1 + Math.floor(random() * 6);
      for (const chunk of chunkIMessageText(content, maxLength)) {
        expect(Array.from(chunk).length).toBeLessThanOrEqual(maxLength);
      }
    }
  });
});
