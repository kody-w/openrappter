#!/usr/bin/env node
// Renders the golden sonic vectors from the OpenRappter host runtime, so the
// Swift port in Sources/Core/MidiDNA.swift can be pinned against the
// implementation it claims parity with rather than against itself.
//
//   node Tools/generate-parity-vectors.mjs
//
// Requires the host TypeScript to have been built (typescript/dist). The
// output is pasted into Tests/RappidFieldTests/SonicIdentityTests.swift.

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const midiModule = resolve(here, '../../../typescript/dist/rappids/midi.js');
const { sonicParameters, buildDnaPrompt, writeMidi } = await import(midiModule);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const BIRTH_TRAITS = {
  canopy: { autonomy: 180, continuity: 720, curiosity: 430, resonance: 500, safety: 880 },
  current: { autonomy: 480, continuity: 540, curiosity: 600, resonance: 640, safety: 560 },
  forge: { autonomy: 860, continuity: 330, curiosity: 880, resonance: 700, safety: 300 },
};

const vectors = Object.entries(BIRTH_TRAITS).map(([path, traits]) => {
  const rappid = `rappid:@field/${path}-companion:${sha256(`rappid-field/fixture/1:${path}`)}`;
  const params = sonicParameters(rappid, traits);
  const prompt = buildDnaPrompt(rappid, traits, params);
  const midi = writeMidi(prompt, params);
  return {
    path,
    rappid,
    parameters: params,
    prompt,
    midiBytes: midi.length,
    midiSha256: createHash('sha256').update(midi).digest('hex'),
  };
});

console.log(JSON.stringify(vectors, null, 2));
