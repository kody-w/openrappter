/**
 * There were two chunkers.
 *
 * `chunkIMessageText` split live replies; `chunkLegacyReply` in
 * imessage-state-store.ts split migrated ones, by slicing code points at 3,000
 * — which is what the live one did before openrappter#58 taught it about
 * grapheme clusters. That fix never reached the copy, so a migrated reply
 * crossing the boundary mid-cluster went into the outbox broken:
 *
 *     legacy chunk0 tail: "a<man><zwj><woman>"
 *     legacy chunk1 head: "<zwj><girl><zwj><boy>"
 *
 * The outbox is what gets sent, so the recipient saw that.
 *
 * These tests pin the property at the boundary the copy got wrong, and are run
 * through both entry points so a fix reaching only one of them fails.
 */
import { describe, it, expect } from 'vitest';
import { chunkIMessageText, IMESSAGE_MAX_CHUNK_LENGTH } from './imessage-chunking.js';
import { chunkIMessageText as reExported } from './imessage.js';

const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const FLAG = '\u{1F1FA}\u{1F1F8}';

const entryPoints: Array<[string, typeof chunkIMessageText]> = [
  ['imessage-chunking', chunkIMessageText],
  ['imessage re-export', reExported],
];

describe.each(entryPoints)('%s at the real 3000 boundary', (_name, chunk) => {
  it.each([
    ['a family emoji', FAMILY],
    ['a regional-indicator flag', FLAG],
    ['a skin-tone modifier', '\u{1F44D}\u{1F3FD}'],
    ['a combining accent', 'e\u0301'],
  ])('does not split %s straddling the boundary', (_label, cluster) => {
    // Place the cluster so a code-point slice at 3000 would cut through it.
    const head = 'a'.repeat(IMESSAGE_MAX_CHUNK_LENGTH - 2);
    const content = `${head}${cluster}${'b'.repeat(50)}`;

    const chunks = chunk(content);

    expect(chunks.join('')).toBe(content);
    for (const piece of chunks) {
      expect(/^[\u0300-\u036F\u200D\u{1F3FB}-\u{1F3FF}]/u.test(piece), JSON.stringify(piece.slice(0, 8))).toBe(false);
      expect(piece.endsWith('\u200D')).toBe(false);
    }
    // The cluster survives intact inside one chunk.
    expect(chunks.some(piece => piece.includes(cluster))).toBe(true);
  });

  it('still splits a long plain reply at the limit', () => {
    const content = 'a'.repeat(IMESSAGE_MAX_CHUNK_LENGTH + 10);
    const chunks = chunk(content);

    expect(chunks).toHaveLength(2);
    expect(Array.from(chunks[0]).length).toBe(IMESSAGE_MAX_CHUNK_LENGTH);
    expect(chunks.join('')).toBe(content);
  });

  it('returns a single empty chunk for empty content', () => {
    // The legacy copy did this too; keeping it means the outbox still gets a
    // row rather than nothing.
    expect(chunk('')).toEqual(['']);
  });
});
