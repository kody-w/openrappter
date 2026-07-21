/**
 * Sense parsing — the weld point between the brain (which produces modality
 * projections) and the surfaces that render them.
 *
 * A "sense" (per the RAPP Sense Spec, `rapp-sense/1.0`) is a modality overlay:
 * the LLM ends a reply with one or more `|||TAG|||`-delimited blocks, each shaped
 * for a channel — `|||VOICE|||` (text-to-speech), `|||HOLO|||` (visual/gesture
 * projection), `|||EMOJI|||`, `|||TLDR|||`, and so on. A single reply carries
 * many projections; each surface renders only the blocks it cares about.
 *
 * This module is that seam. It replaces openrappter's one-off `|||VOICE|||`
 * split with a general parser so every surface (iMessage, VUI, cards…) reads
 * the same structured shape. It is intentionally tiny and dependency-free —
 * the weld point, nothing more.
 */

/** A reply split into its main text and its sense projections. */
export interface ParsedSenses {
  /** The main reply — everything before the first sense marker. */
  text: string;
  /** Sense tag (lower-cased, e.g. "voice", "holo") → that block's content. */
  senses: Record<string, string>;
}

// A sense marker: |||TAG||| where TAG is 2–16 uppercase letters/digits/underscore.
const SENSE_MARKER = /\|\|\|([A-Z][A-Z0-9_]{1,15})\|\|\|/g;

/**
 * Parse a reply into its main text plus any `|||TAG|||` sense blocks.
 *
 * - No markers → `{ text: <whole reply>, senses: {} }`.
 * - Content before the first marker is the main text; each marker owns the
 *   text up to the next marker (or end of string).
 * - Empty blocks are dropped. Duplicate tags: last one wins.
 */
export function parseSenses(reply: string): ParsedSenses {
  if (!reply) return { text: '', senses: {} };

  const markers: Array<{ tag: string; start: number; contentStart: number }> = [];
  SENSE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENSE_MARKER.exec(reply)) !== null) {
    markers.push({ tag: m[1].toLowerCase(), start: m.index, contentStart: m.index + m[0].length });
  }

  if (markers.length === 0) return { text: reply.trim(), senses: {} };

  const text = reply.slice(0, markers[0].start).trim();
  const senses: Record<string, string> = {};
  for (let i = 0; i < markers.length; i++) {
    const stop = i + 1 < markers.length ? markers[i + 1].start : reply.length;
    const content = reply.slice(markers[i].contentStart, stop).trim();
    if (content) senses[markers[i].tag] = content;
  }
  return { text, senses };
}

/** Convenience: the spoken (`|||VOICE|||`) projection, or '' if none. */
export function voiceOf(parsed: ParsedSenses): string {
  return parsed.senses.voice ?? '';
}
