/**
 * MIDI DNA: the stable identity motif, and the bytes it renders to.
 *
 * `NOTE(pitch, delta_onset, duration, velocity)` is the whole note event, the
 * representation described at <https://simedw.com/2026/08/20/midi-autocomplete/>.
 * Everything here is a pure function of the RAPPID and the organism's stable
 * traits, so the same creature produces the same 16-note prompt on any device,
 * offline, forever — and *only* the prompt. Identity is never derived from the
 * motif; the motif is derived from the identity.
 *
 * The derivation and the file writer are checked against a live organism: the
 * prompt recorded in `sonic/sonic-profile.json` and the exact bytes of
 * `sonic/assets/dna-prompt.mid` are both reproduced from the RAPPID and
 * `traits.json` alone.
 *
 * Mirrored by `python/openrappter/rappids/midi.py`.
 */

import { createHash } from 'node:crypto';

import {
  DeterministicStream,
  canonicalJson,
  idiv,
  roundHalfUp,
  sha256Hex,
} from './canonical.js';
import { QuantumRappidError } from './types.js';
import type { JsonObject, MusicalParameters, Note } from './types.js';

/** Pulses per quarter note, and the sixteenth-note grid built on it. */
export const PPQ = 480;
export const STEP = PPQ / 4;

const MODES = [
  { name: 'ionian', scale: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'dorian', scale: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'lydian', scale: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'mixolydian', scale: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'major-pentatonic', scale: [0, 2, 4, 7, 9] },
] as const;
const PROGRAMS = [4, 11, 80, 81, 89] as const;
const CORE_DEGREES = [0, 2, 4, 1, 3, 5, 4, 2];
const ONSET_CHOICES = [STEP * 2, STEP * 2, STEP * 3, STEP * 4];
const DURATION_CHOICES = [STEP * 2, STEP * 3, STEP * 4];

export function clampInt(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** The nearest pitch in the mode, ties broken downward so it is total. */
export function nearestScalePitch(value: number, root: number, scale: readonly number[]): number {
  let best = root;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let octave = -1; octave < 4; octave += 1) {
    for (const degree of scale) {
      const pitch = root + octave * 12 + degree;
      const distance = Math.abs(pitch - value);
      if (distance < bestDistance || (distance === bestDistance && pitch < best)) {
        best = pitch;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function sortedTraits(traitsMilli: Record<string, number>): JsonObject {
  const sorted: JsonObject = {};
  for (const key of Object.keys(traitsMilli).sort()) {
    sorted[key] = traitsMilli[key];
  }
  return sorted;
}

function identityStream(
  rappid: string,
  birthTraitsMilli: Record<string, number>,
  purpose: string,
): DeterministicStream {
  return new DeterministicStream(sha256Hex(canonicalJson({
    rappid,
    birth_traits_milli: sortedTraits(birthTraitsMilli),
    purpose,
  })));
}

/** Key, tempo and voice, frozen from identity plus the birth trait snapshot. */
export function sonicParameters(
  rappid: string,
  birthTraitsMilli: Record<string, number>,
): MusicalParameters {
  const stream = identityStream(rappid, birthTraitsMilli, 'parameters');
  const rootPitchClass = stream.nextBelow(12);
  const mode = MODES[stream.nextBelow(MODES.length)];
  return {
    rootPitch: stream.nextBelow(2) === 0
      ? 48 + rootPitchClass
      : 60 + rootPitchClass,
    rootPitchClass,
    mode: mode.name,
    scale: [...mode.scale],
    bpm: 96 + stream.nextBelow(25),
    program: PROGRAMS[stream.nextBelow(PROGRAMS.length)],
  };
}

/**
 * The 16-note identity motif: an 8-note call and birth-frozen response.
 *
 * Call and response are the whole point of the shape — the response is the
 * call reversed, then bent by the traits that have a musical meaning, so a
 * curious creature answers itself with wider colour while a continuity-bound
 * one answers itself almost literally.
 */
export function buildDnaPrompt(
  rappid: string,
  birthTraitsMilli: Record<string, number>,
  params: MusicalParameters,
): Note[] {
  const identity = createHash('sha256')
    .update(canonicalJson({
      rappid,
      birth_traits_milli: sortedTraits(birthTraitsMilli),
      purpose: 'midi-dna',
    }), 'utf8')
    .digest();
  const degrees = CORE_DEGREES.map((degree, index) =>
    clampInt(degree + ((identity[index] % 3) - 1), 0, params.scale.length - 1),
  );
  const contour = degrees.map((degree) => params.rootPitch + 12 + params.scale[degree]);
  const response = [...contour].reverse().map((pitch, index) => {
    const octaveEcho =
      (index === 1 || index === 5) && (identity[index] & 0x1) !== 0
        ? 12
        : 0;
    const colour =
      (index === 3 || index === 7) && (identity[index] & 0x2) !== 0
        ? 2
        : 0;
    return nearestScalePitch(pitch + octaveEcho + colour, params.rootPitch, params.scale);
  });

  return [...contour, ...response].map((pitch, index) => {
    let deltaOnset = index === 0 ? 0 : ONSET_CHOICES[identity[16 + index] % 4];
    if (
      (index === 4 || index === 12)
      && (identity[8 + index] & 0x1) !== 0
    ) {
      deltaOnset = STEP;
    }
    const velocity = 70 + (identity[identity.length - 1 - index] % 24);
    return {
      pitch,
      deltaOnset,
      duration: DURATION_CHOICES[identity[index] % 3],
      velocity: index === 0 || index === 8 || index === 15 ? Math.min(108, velocity + 10) : velocity,
    };
  });
}

/** MIDI variable-length quantity. */
export function variableLength(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('variable-length quantities are non-negative integers');
  }
  let remaining = value;
  let buffer = remaining & 0x7f;
  const out: number[] = [];
  while (remaining >> 7) {
    remaining >>= 7;
    buffer <<= 8;
    buffer |= (remaining & 0x7f) | 0x80;
  }
  for (;;) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return out;
}

/**
 * A single-track SMF, byte-for-byte reproducible.
 *
 * The octave echo under notes 8 and 16 is deliberate and inherited: it is what
 * the organism's own sonic dimension was rendered with, so this writer
 * reproduces `dna-prompt.mid` exactly rather than producing a second, subtly
 * different rendering of the same motif.
 */
export function writeMidi(notes: readonly Note[], params: MusicalParameters): Buffer {
  if (notes.length === 0) {
    throw new QuantumRappidError('empty-midi', 'refusing to render a MIDI file with no notes');
  }
  const spans: Array<{
    onset: number;
    end: number;
    pitch: number;
    velocity: number;
    channel: number;
  }> = [];
  let onset = 0;
  notes.forEach((note, index) => {
    onset += note.deltaOnset;
    spans.push({
      onset,
      end: onset + note.duration,
      pitch: note.pitch,
      velocity: note.velocity,
      channel: 0,
    });
    if ((index === 7 || index === 15) && index + 1 < notes.length) {
      spans.push({
        onset,
        end: onset + note.duration,
        pitch: clampInt(note.pitch - 12, 36, 96),
        velocity: Math.max(34, note.velocity - 28),
        channel: 1,
      });
    }
  });
  for (const channel of [0, 1]) {
    for (let pitch = 0; pitch < 128; pitch += 1) {
      const matching = spans
        .filter((span) => span.channel === channel && span.pitch === pitch)
        .sort((left, right) => left.onset - right.onset);
      for (let index = 1; index < matching.length; index += 1) {
        const previous = matching[index - 1];
        const current = matching[index];
        if (previous.end >= current.onset) {
          previous.end = Math.max(previous.onset + 1, current.onset - 1);
        }
      }
    }
  }
  const events: Array<{ tick: number; kind: number; payload: number[] }> = [];
  for (const span of spans) {
    events.push({
      tick: span.onset,
      kind: 1,
      payload: [0x90 | span.channel, span.pitch, span.velocity],
    });
    events.push({
      tick: span.end,
      kind: 0,
      payload: [0x80 | span.channel, span.pitch, 0],
    });
  }
  events.sort((left, right) => left.tick - right.tick || left.kind - right.kind);

  const tempo = roundHalfUp(60_000_000 / params.bpm);
  const track: number[] = [];
  const trackName = Buffer.from('Quantum RAPPID', 'ascii');
  track.push(0x00, 0xff, 0x03, trackName.length, ...trackName);
  track.push(0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff);
  track.push(0x00, 0xc0, params.program);
  track.push(0x00, 0xc1, params.program);
  let current = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - current), ...event.payload);
    current = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'ascii');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt16BE(PPQ, 12);
  const chunk = Buffer.alloc(8);
  chunk.write('MTrk', 0, 'ascii');
  chunk.writeUInt32BE(track.length, 4);
  return Buffer.concat([header, chunk, Buffer.from(track)]);
}

/** Total ticks a note list occupies, for playback without rendering it. */
export function midiDurationTicks(notes: readonly Note[]): number {
  let onset = 0;
  let end = 0;
  for (const note of notes) {
    onset += note.deltaOnset;
    end = Math.max(end, onset + note.duration);
  }
  return end;
}

/** Ticks to whole milliseconds, so playback timing stays integer. */
export function ticksToMilliseconds(ticks: number, bpm: number): number {
  return idiv(ticks * 60_000, bpm * PPQ);
}

/** The on-disk note form is snake_case; this is the only place that knows. */
export function noteFromJson(value: JsonObject, where: string): Note {
  type NoteField = 'pitch' | 'delta_onset' | 'duration' | 'velocity';
  const read = (key: NoteField): number => {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      throw new QuantumRappidError(
        'invalid-note',
        `${where}: note field ${key} must be an integer, got ${JSON.stringify(raw)}`,
      );
    }
    return raw;
  };
  return {
    pitch: read('pitch'),
    deltaOnset: read('delta_onset'),
    duration: read('duration'),
    velocity: read('velocity'),
  };
}

export function noteToJson(note: Note): JsonObject {
  return {
    pitch: note.pitch,
    delta_onset: note.deltaOnset,
    duration: note.duration,
    velocity: note.velocity,
  };
}
