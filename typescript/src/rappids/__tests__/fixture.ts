/**
 * A real organism on disk, built the way a habitat would build one.
 *
 * The live organism at `~/.rapp/twins/<hex>/` is the evidence this subsystem
 * was designed against, and tests deliberately do not read it: it is a working
 * creature that is still being grown, its manifest has already changed shape
 * twice, and a suite that asserts against a moving organism is a suite that
 * fails for reasons that have nothing to do with the code under test. So the
 * *shape* is copied here and the bytes are generated, which also means every
 * test can tamper freely.
 *
 * Scratch data stays inside the repo under `.test-scratch/` (gitignored), the
 * convention `skills-connections-contract.test.ts` already uses.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { canonicalDigest, sha256Hex, traitMilli } from '../canonical.js';
import { buildDnaPrompt, noteToJson, sonicParameters, writeMidi } from '../midi.js';
import { proposeContinuation } from '../autocomplete.js';
import { rappidHex } from '../identity.js';
import type { JsonObject, JsonValue } from '../types.js';

export const SCRATCH_ROOT = join(process.cwd(), '.test-scratch');

export const TEST_TRAITS: Record<string, number> = {
  autonomy: 0.88,
  continuity: 0.97,
  curiosity: 0.84,
  dimensionality: 0.92,
  evidence_bound: 0.98,
  local_first: 1.0,
  playfulness: 0.72,
  resilience: 0.94,
  warmth: 0.76,
};

export interface ExtraDimension {
  name: string;
  status: string;
  refs?: Record<string, string>;
  playback?: string[];
  /** Files written under the organism, keyed by path relative to it. */
  files?: Record<string, string>;
}

export interface OrganismFixtureOptions {
  habitat: string;
  tail?: string;
  owner?: string;
  name?: string;
  displayName?: string;
  traits?: Record<string, number>;
  parentRappid?: string | null;
  extraDimensions?: ExtraDimension[];
  /** Overrides the RAPPID written into `traits.json`, to fake identity drift. */
  traitsRappid?: string;
  withSonic?: boolean;
}

export interface OrganismFixture {
  habitat: string;
  directory: string;
  rappid: string;
  hex: string;
  traits: Record<string, number>;
  promptMidiBytes: number;
  autocompleteMidiBytes: number;
}

/** A scratch habitat that cleans up after itself. */
export function makeHabitat(label: string): string {
  const habitat = join(SCRATCH_ROOT, `rappids-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(habitat, { recursive: true });
  return habitat;
}

export function removeHabitat(habitat: string): void {
  rmSync(habitat, { recursive: true, force: true });
}

function writeJson(path: string, value: JsonValue): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Write one organism: identity, traits, a sonic dimension and its MIDI assets.
 *
 * The sonic manifest embeds `manifest_sha256` over its own canonical JSON,
 * which is the spelling a tampering test can break by editing one number.
 */
export function buildOrganism(options: OrganismFixtureOptions): OrganismFixture {
  const tail = options.tail ?? 'test-tail';
  const owner = options.owner ?? 'openrappter';
  const name = options.name ?? 'parity-organism';
  const traits = options.traits ?? TEST_TRAITS;
  const hex = rappidHex(tail);
  const rappid = `rappid:@${owner}/${name}:${hex}`;
  const directory = join(options.habitat, hex);
  mkdirSync(directory, { recursive: true });

  const traitsMilli: Record<string, number> = {};
  for (const key of Object.keys(traits).sort()) traitsMilli[key] = traitMilli(traits[key]);

  const dimensions: JsonObject = {
    memory: { status: 'awake', latest_cursor: '0002' },
    device: { status: 'local', playback: ['audio/midi'] },
  };

  let promptMidiBytes = 0;
  let autocompleteMidiBytes = 0;

  if (options.withSonic !== false) {
    const params = sonicParameters(rappid, traitsMilli);
    const prompt = buildDnaPrompt(rappid, traitsMilli, params);
    const continuation = proposeContinuation({
      rappid,
      traitsMilli,
      params,
      prompt,
      engramCursor: '0002',
    });
    const promptMidi = writeMidi(prompt, params);
    const autocompleteMidi = writeMidi([...prompt, ...continuation.continuation], params);
    promptMidiBytes = promptMidi.length;
    autocompleteMidiBytes = autocompleteMidi.length;

    mkdirSync(join(directory, 'sonic', 'assets'), { recursive: true });
    writeFileSync(join(directory, 'sonic', 'assets', 'dna-prompt.mid'), promptMidi);
    writeFileSync(join(directory, 'sonic', 'assets', 'autocomplete.mid'), autocompleteMidi);

    const profile: JsonObject = {
      schema: 'quantum-rappid-sonic/1.0',
      rappid,
      dimension: 'sonic',
      identity: {
        identity_seed_sha256: canonicalDigest({ rappid, traits: traitsMilli }),
        evolution_seed_sha256: canonicalDigest({ rappid, traits: traitsMilli, engram: '0002' }),
        invariant: 'Canonical RAPPID identity and 16-note MIDI DNA stay stable.',
      },
      traits,
      musical_parameters: {
        root_pitch: params.rootPitch,
        root_pitch_class: params.rootPitchClass,
        mode: params.mode,
        scale: params.scale,
        bpm: params.bpm,
        program_zero_based: params.program,
        program_gm_one_based: params.program + 1,
      },
      note_representation: ['pitch', 'delta_onset', 'duration', 'velocity'],
      prompt: prompt.map(noteToJson),
      assets: [
        {
          path: 'assets/dna-prompt.mid',
          bytes: promptMidi.length,
          sha256: sha256Hex(promptMidi),
          media_type: 'audio/midi',
        },
        {
          path: 'assets/autocomplete.mid',
          bytes: autocompleteMidi.length,
          sha256: sha256Hex(autocompleteMidi),
          media_type: 'audio/midi',
        },
      ],
      device_playback: {
        midi_data: {
          prompt: 'assets/dna-prompt.mid',
          autocomplete: 'assets/autocomplete.mid',
          playback_requirement: 'MIDI synth or native sequencer',
        },
        requires_user_gesture: true,
        stop_control_required: true,
      },
      creature_stats: { lifecycle_stage: 'baby' },
    };
    profile.manifest_sha256 = canonicalDigest(profile);
    writeJson(join(directory, 'sonic', 'sonic-profile.json'), profile);

    dimensions.sonic = {
      status: 'active',
      profile: 'sonic/sonic-profile.json',
      midi_dna: 'sonic/assets/dna-prompt.mid',
      autocomplete: 'sonic/assets/autocomplete.mid',
    };
  }

  for (const extra of options.extraDimensions ?? []) {
    const record: JsonObject = { status: extra.status };
    for (const [key, ref] of Object.entries(extra.refs ?? {})) record[key] = ref;
    if (extra.playback !== undefined) record.playback = [...extra.playback];
    dimensions[extra.name] = record;
    for (const [path, contents] of Object.entries(extra.files ?? {})) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    }
  }

  writeJson(join(directory, 'rappid.json'), {
    schema: 'rapp-rappid/2.0',
    rappid,
    kind: 'quantum-rappid',
    name,
    display_name: options.displayName ?? 'Parity',
    url: `local://quantum-rappids/${hex}/`,
    parent_rappid: options.parentRappid ?? null,
    born_at: '2026-08-20T19:50:33Z',
    kernel_version: '0.6.16',
    external_episode: {
      source: 'copilot-cli',
      session_guid: 'e479d694-8712-4e77-aa22-2ec4d4e57089',
      memory_key: 'rappid-capture/1/copilot-cli/sessions/e479d694-8712-4e77-aa22-2ec4d4e57089',
    },
    quantum: {
      schema: 'quantum-rappid/1.0',
      invariant: 'One canonical identity, many independently renderable dimensions.',
      dimensions,
    },
    _local_only: true,
  });

  writeJson(join(directory, 'traits.json'), {
    schema: 'quantum-rappid-traits/1.0',
    rappid: options.traitsRappid ?? rappid,
    birth_traits: traits,
    traits,
  });

  return {
    habitat: options.habitat,
    directory,
    rappid,
    hex,
    traits,
    promptMidiBytes,
    autocompleteMidiBytes,
  };
}
