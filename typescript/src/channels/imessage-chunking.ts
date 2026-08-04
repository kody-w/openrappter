/**
 * Splitting a reply into sendable chunks, in one place.
 *
 * This lived in imessage.ts, and a second copy — `chunkLegacyReply`, in
 * imessage-state-store.ts — did the same job by slicing code points. When
 * openrappter#58 taught this one about grapheme clusters, that copy kept the
 * old behaviour and went on cutting families, flags and skin tones in half on
 * its way into the outbox.
 *
 * It is a module rather than an import from imessage.ts because imessage.ts
 * already imports from the state store; importing a value back would close a
 * runtime cycle.
 */

export const IMESSAGE_MAX_CHUNK_LENGTH = 3000;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Split by code point. Only used for a single grapheme too large to fit. */
function chunkByCodePoint(content: string, maxLength: number): string[] {
  const codePoints = Array.from(content);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maxLength) {
    chunks.push(codePoints.slice(index, index + maxLength).join(''));
  }
  return chunks;
}

/**
 * Split a reply into sendable chunks without breaking what the reader sees.
 *
 * This used to slice on code points, which keeps surrogate pairs intact but is
 * not what a character is. Many everyday characters are several code points,
 * and cutting between them corrupts the message in a way that is obvious to the
 * recipient and invisible to us:
 *
 *   👨‍👩‍👧‍👦  ->  "👨‍" + "👩‍👧‍" + "👦"   a family becomes four people and stray joiners
 *   🇺🇸       ->  "🇺"  + "🇸"            a flag becomes two letters
 *   👍🏽       ->  "👍" + "🏽"             the skin tone is orphaned as a colour swatch
 *   é (e+◌́)   ->  "e"  + "́"              the accent lands on the next message
 *
 * Segmenting by grapheme cluster is the correct unit. `maxLength` still counts
 * code points so the existing limit means the same thing as before.
 *
 * A single grapheme larger than `maxLength` cannot be honoured both ways. We
 * keep the limit — exceeding it risks the send failing outright — and fall back
 * to code points for that one cluster, which also guarantees progress rather
 * than looping forever on something that never fits.
 */
export function chunkIMessageText(
  content: string,
  maxLength = IMESSAGE_MAX_CHUNK_LENGTH,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('iMessage chunk length must be a positive integer');
  }
  if (content.length === 0) return [''];

  const chunks: string[] = [];
  let current = '';
  let currentLength = 0;

  for (const { segment } of graphemeSegmenter.segment(content)) {
    const segmentLength = Array.from(segment).length;

    if (segmentLength > maxLength) {
      if (current) {
        chunks.push(current);
        current = '';
        currentLength = 0;
      }
      chunks.push(...chunkByCodePoint(segment, maxLength));
      continue;
    }

    if (currentLength + segmentLength > maxLength) {
      chunks.push(current);
      current = '';
      currentLength = 0;
    }
    current += segment;
    currentLength += segmentLength;
  }

  if (current) chunks.push(current);
  return chunks;
}
