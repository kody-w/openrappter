/**
 * What a Quantum RAPPID must survive.
 *
 * The claims under test are the ones the product makes out loud: one identity
 * across every dimension, weight that is verified rather than asserted, growth
 * that appends instead of re-minting, and a habitat that refuses to play bytes
 * which no longer match their content address.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  QuantumRappidError,
  appendBodyFrame,
  bodyFrameToJson,
  buildDimensionFrame,
  buildGrowthProposal,
  completeRappid,
  contiguousFrameHeight,
  deriveStage,
  deriveStats,
  dimensionStates,
  growOrganism,
  listOrganismSummaries,
  loadOrganism,
  loadOrganismByRappid,
  playbackManifest,
  readAssetPayload,
  mediaRef,
  storeRappObject,
  summarize,
  sonicContext,
  verifyOrganism,
} from '../index.js';
import type { LoadedOrganism } from '../index.js';
import { buildOrganism, makeHabitat, removeHabitat } from './fixture.js';

const habitats: string[] = [];

function habitat(label: string): string {
  const created = makeHabitat(label);
  habitats.push(created);
  return created;
}

afterEach(() => {
  while (habitats.length > 0) removeHabitat(habitats.pop() as string);
});

function check(organism: LoadedOrganism, name: string): { status: string; detail: string } {
  const report = verifyOrganism(organism);
  const found = report.checks.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe('a verified organism', () => {
  it('verifies every claim it makes about itself', () => {
    const fixture = buildOrganism({ habitat: habitat('verified') });
    const organism = loadOrganism(fixture.directory);
    const report = verifyOrganism(organism);

    expect(report.checks.filter((entry) => entry.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
    // Two MIDI assets, each counted once by (dimension, sha256).
    expect(report.verifiedAddresses).toHaveLength(2);
  });

  it('weighs exactly what it can produce, and says so when a size is unknown', () => {
    const fixture = buildOrganism({ habitat: habitat('weight') });
    const organism = loadOrganism(fixture.directory);
    const summary = summarize(organism, verifyOrganism(organism));

    expect(summary.stats.residentWeightBytes).toBe(
      fixture.promptMidiBytes + fixture.autocompleteMidiBytes,
    );
    expect(summary.stats.uniqueAssets).toBe(2);
    expect(summary.stats.frameHeight).toBe(0);
    // The memory dimension points at an engram cursor whose size is not known
    // here, so the total is incomplete rather than estimated.
    expect(summary.stats.weightComplete).toBe(false);
    expect(summary.stats.totalWeightBytes).toBeNull();
    expect(summary.unmeasuredDimensions).toEqual(['memory']);
  });

  it('never counts the same content address twice', () => {
    const fixture = buildOrganism({ habitat: habitat('dedupe') });
    const organism = loadOrganism(fixture.directory);
    const report = verifyOrganism(organism);
    const doubled = {
      ...report,
      assets: [...report.assets, ...report.assets],
    };
    const dimensions = dimensionStates(organism, doubled);

    expect(deriveStats(organism, doubled, dimensions).residentWeightBytes).toBe(
      fixture.promptMidiBytes + fixture.autocompleteMidiBytes,
    );
  });

  it('counts distinct missing assets instead of collapsing them onto an empty address', () => {
    const fixture = buildOrganism({ habitat: habitat('missing-weight') });
    const documentPath = join(fixture.directory, 'rappid.json');
    const document = JSON.parse(readFileSync(documentPath, 'utf8'));
    document.quantum.dimensions.memory.latest_cursor = 'memory/cursor.json';
    writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    unlinkSync(join(fixture.directory, 'sonic', 'assets', 'dna-prompt.mid'));
    unlinkSync(join(fixture.directory, 'sonic', 'assets', 'autocomplete.mid'));

    const organism = loadOrganism(fixture.directory);
    const report = verifyOrganism(organism);
    const dimensions = dimensionStates(organism, report);
    const stats = deriveStats(organism, report, dimensions);

    expect(report.assets.map((asset) => asset.status)).toEqual(['missing', 'missing']);
    expect(stats.linkedWeightBytes).toBe(
      fixture.promptMidiBytes + fixture.autocompleteMidiBytes,
    );
    expect(stats.totalWeightBytes).toBe(stats.linkedWeightBytes);
    expect(stats.weightComplete).toBe(true);
  });

  it('starts as a baby and reports its habitat, lineage and playback policy', () => {
    const fixture = buildOrganism({ habitat: habitat('baby') });
    const organism = loadOrganism(fixture.directory);
    const summary = summarize(organism, verifyOrganism(organism));

    expect(summary.lifecycleStage).toBe('baby');
    expect(summary.parentRappid).toBeNull();
    expect(summary.localOnly).toBe(true);
    expect(summary.stats.displayHeightMm).toBe(420);

    const manifest = playbackManifest(fixture.rappid, { root: fixture.habitat });
    expect(manifest.playbackMode).toBe('in-process-bytes');
    expect(manifest.requiresUserGesture).toBe(true);
    expect(manifest.stopControlRequired).toBe(true);
    expect(manifest.tracks.map((track) => track.role)).toEqual(['midi-dna', 'midi-autocomplete']);
    expect(manifest.tracks.every((track) => track.verified)).toBe(true);
  });

  it('lists organisms from a habitat and finds one by RAPPID', () => {
    const home = habitat('list');
    const first = buildOrganism({ habitat: home, tail: 'one', name: 'first-organism' });
    const second = buildOrganism({ habitat: home, tail: 'two', name: 'second-organism' });

    const summaries = listOrganismSummaries({ root: home });
    expect(summaries.map((entry) => entry.rappid).sort()).toEqual(
      [first.rappid, second.rappid].sort(),
    );
    expect(loadOrganismByRappid(second.rappid, home).directory).toBe(second.directory);
  });

  it('keeps identity MIDI fixed while live traits evolve continuation', () => {
    const home = habitat('birth-traits');
    const fixture = buildOrganism({ habitat: home, withSonic: false });
    const before = loadOrganism(fixture.directory);
    const beforeContext = sonicContext(before);
    const beforeCompletion = completeRappid(fixture.rappid, { root: home });

    const traitsPath = join(fixture.directory, 'traits.json');
    const traits = JSON.parse(readFileSync(traitsPath, 'utf8')) as {
      traits: Record<string, number>;
    };
    traits.traits.autonomy = 0.11;
    traits.traits.curiosity = 0.12;
    traits.traits.playfulness = 0.13;
    writeFileSync(traitsPath, `${JSON.stringify(traits, null, 2)}\n`);

    const after = loadOrganism(fixture.directory);
    const afterContext = sonicContext(after);
    const afterCompletion = completeRappid(fixture.rappid, { root: home });

    expect(afterContext).toEqual(beforeContext);
    expect(afterCompletion.prompt).toEqual(beforeCompletion.prompt);
    expect(afterCompletion.midiSha256).not.toBe(beforeCompletion.midiSha256);
  });
});

describe('tampering', () => {
  it('catches a media file whose bytes no longer match its content address', () => {
    const fixture = buildOrganism({ habitat: habitat('media-hash') });
    const asset = join(fixture.directory, 'sonic', 'assets', 'dna-prompt.mid');
    const bytes = readFileSync(asset);
    // Same length, one different byte: a byte-count check alone would miss it.
    bytes[bytes.length - 2] ^= 0x01;
    writeFileSync(asset, bytes);

    const report = verifyOrganism(loadOrganism(fixture.directory));
    const broken = report.assets.find((entry) => entry.path === 'assets/dna-prompt.mid');
    expect(broken?.status).toBe('hash-mismatch');
    expect(broken?.actualBytes).toBe(bytes.length);
    expect(report.ok).toBe(false);
    expect(report.verifiedAddresses).toHaveLength(1);
  });

  it('catches a truncated media file as a byte mismatch', () => {
    const fixture = buildOrganism({ habitat: habitat('media-bytes') });
    const asset = join(fixture.directory, 'sonic', 'assets', 'autocomplete.mid');
    writeFileSync(asset, readFileSync(asset).subarray(0, 32));

    const report = verifyOrganism(loadOrganism(fixture.directory));
    expect(report.assets.find((entry) => entry.path === 'assets/autocomplete.mid')?.status).toBe(
      'byte-mismatch',
    );
    expect(report.ok).toBe(false);
  });

  it('refuses to hand a player bytes that do not match the manifest', () => {
    const home = habitat('playback-tamper');
    const fixture = buildOrganism({ habitat: home });
    const asset = join(fixture.directory, 'sonic', 'assets', 'dna-prompt.mid');
    writeFileSync(asset, Buffer.concat([readFileSync(asset), Buffer.from([0x00])]));

    expect(() => readAssetPayload(fixture.rappid, 'midi-dna', { root: home })).toThrow(
      /does not match its content address/,
    );
  });

  it('serves verified bytes with their content address', () => {
    const home = habitat('playback-ok');
    const fixture = buildOrganism({ habitat: home });
    const payload = readAssetPayload(fixture.rappid, 'midi-dna', { root: home });

    expect(payload.mediaType).toBe('audio/midi');
    expect(payload.bytes).toBe(fixture.promptMidiBytes);
    expect(Buffer.from(payload.base64, 'base64')).toHaveLength(fixture.promptMidiBytes);
  });

  it('catches an edited sonic manifest through its embedded hash', () => {
    const fixture = buildOrganism({ habitat: habitat('manifest') });
    const profilePath = join(fixture.directory, 'sonic', 'sonic-profile.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    (profile.musical_parameters as Record<string, unknown>).bpm = 999;
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

    expect(check(loadOrganism(fixture.directory), 'sonic.manifest').status).toBe('fail');
  });

  it('will not call a dimension verified when nothing can check its manifest', () => {
    const fixture = buildOrganism({ habitat: habitat('no-manifest') });
    const profilePath = join(fixture.directory, 'sonic', 'sonic-profile.json');
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    delete profile.manifest_sha256;
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

    const failure = check(loadOrganism(fixture.directory), 'sonic.manifest');
    expect(failure.status).toBe('fail');
    expect(failure.detail).toContain('no manifest hash');
  });

  it('reads a sha256sum sidecar, and catches it disagreeing with the file', () => {
    const fixture = buildOrganism({ habitat: habitat('sidecar') });
    const sidecar = join(fixture.directory, 'sonic', 'sonic-profile.sha256');
    writeFileSync(sidecar, `${'0'.repeat(64)}  sonic-profile.json\n`);

    const failure = check(loadOrganism(fixture.directory), 'sonic.manifest');
    expect(failure.status).toBe('fail');
    expect(failure.detail).toContain('sonic-profile.sha256 records');
  });

  it('catches a dimension ref that points at a file which is not there', () => {
    const fixture = buildOrganism({
      habitat: habitat('dangling-ref'),
      extraDimensions: [
        { name: 'skill', status: 'recorded', refs: { manifest: 'skill/SKILL.md' } },
      ],
    });

    expect(check(loadOrganism(fixture.directory), 'dimensions.refs').status).toBe('fail');
  });

  it('refuses a manifest path that climbs out of the organism', () => {
    const fixture = buildOrganism({ habitat: habitat('escape') });
    const rappidPath = join(fixture.directory, 'rappid.json');
    const document = JSON.parse(readFileSync(rappidPath, 'utf8')) as {
      quantum: { dimensions: Record<string, Record<string, unknown>> };
    };
    document.quantum.dimensions.sonic.profile = '../../../../etc/passwd';
    writeFileSync(rappidPath, `${JSON.stringify(document, null, 2)}\n`);

    const failure = check(loadOrganism(fixture.directory), 'dimensions.refs');
    expect(failure.status).toBe('fail');
    expect(failure.detail).toContain('resolves outside the organism directory');
  });
});

describe('identity', () => {
  it('catches a second identity hiding inside one organism', () => {
    const other = `rappid:@openrappter/other-organism:${'a'.repeat(64)}`;
    const fixture = buildOrganism({ habitat: habitat('drift'), traitsRappid: other });

    const failure = check(loadOrganism(fixture.directory), 'identity.single');
    expect(failure.status).toBe('fail');
    expect(failure.detail).toContain('traits.json says');
  });

  it('catches a habitat directory that does not match the RAPPID', () => {
    const home = habitat('habitat-drift');
    const fixture = buildOrganism({ habitat: home });
    const moved = join(home, 'b'.repeat(64));
    renameSync(fixture.directory, moved);

    const failure = check(loadOrganism(moved), 'identity.habitat');
    expect(failure.status).toBe('fail');
    expect(failure.detail).toContain('does not match the RAPPID hex');
  });

  it('accepts a parent pointer for true offspring and refuses self-parenthood', () => {
    const parent = `rappid:@openrappter/parent-organism:${'c'.repeat(64)}`;
    const child = buildOrganism({ habitat: habitat('offspring'), parentRappid: parent });
    const organism = loadOrganism(child.directory);
    expect(organism.document.parentRappid).toBe(parent);
    expect(check(organism, 'identity.lineage').detail).toContain('true offspring of');

    const selfish = buildOrganism({ habitat: habitat('self-parent') });
    const rappidPath = join(selfish.directory, 'rappid.json');
    const document = JSON.parse(readFileSync(rappidPath, 'utf8')) as Record<string, unknown>;
    document.parent_rappid = selfish.rappid;
    writeFileSync(rappidPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(() => loadOrganism(selfish.directory)).toThrow(QuantumRappidError);
    expect(() => loadOrganism(selfish.directory)).toThrow(/points at itself as its parent/);
  });
});

describe('growth', () => {
  it('appends a verified frame without touching the identity', () => {
    const home = habitat('grow');
    const fixture = buildOrganism({ habitat: home });
    const before = loadOrganism(fixture.directory);
    const proposal = buildGrowthProposal(before, 'sonic').proposal;

    expect(proposal.authoritative).toBe(false);
    expect(proposal.predictedStats.frameHeight).toBe(1);

    const organism = loadOrganism(fixture.directory);
    const result = growOrganism(organism, proposal.id, {
      createdAt: '2026-08-20T20:00:00.000Z',
    });

    expect(result.rappid).toBe(fixture.rappid);
    expect(result.summary.rappid).toBe(fixture.rappid);
    expect(result.appended.seq).toBe(0);
    expect(result.appended.prev).toBeNull();
    expect(Object.keys(bodyFrameToJson(result.appended))).toHaveLength(11);
    expect(result.appended.spec).toBe('rapp/1');
    expect(result.appended.kind).toBe('body.dimension');
    expect(result.summary.stats.frameHeight).toBe(1);
    expect(result.verification.ok).toBe(true);
    expect(existsSync(result.framePath)).toBe(true);
    // The prediction quoted exact bytes, so it has to match what landed.
    expect(result.summary.stats.residentWeightBytes).toBe(
      proposal.predictedStats.residentWeightBytes,
    );
  });

  it('records the same lifecycle stage that the approved preview displays', () => {
    const fixture = buildOrganism({
      habitat: habitat('stage-parity'),
      extraDimensions: [
        {
          name: 'skill',
          status: 'active',
          refs: { artifact: 'skill/SKILL.md' },
          files: { 'skill/SKILL.md': '# Recorded skill\n' },
        },
        {
          name: 'visual',
          status: 'active',
          refs: { sprite: 'visual/sprite.svg' },
          files: { 'visual/sprite.svg': '<svg></svg>\n' },
        },
      ],
    });
    let organism = loadOrganism(fixture.directory);
    appendBodyFrame(organism, buildDimensionFrame({
      rappid: fixture.rappid,
      seq: 0,
      utc: '2026-08-20T19:00:00.000Z',
      prev: null,
      dimension: 'sonic',
      version: 1,
      stage: { name: 'baby', ordinal: 0 },
      traits: { ...organism.traits.traitsMilli },
      media: {},
    }));

    organism = loadOrganism(fixture.directory);
    const proposal = buildGrowthProposal(organism, 'sonic').proposal;
    expect(proposal.predictedStage).toBe('hatchling');
    const result = growOrganism(organism, proposal.id, {
      createdAt: '2026-08-20T20:00:00.000Z',
    });

    expect(result.appended.payload.stage.name).toBe(proposal.predictedStage);
    expect(result.summary.lifecycleStage).toBe(proposal.predictedStage);
  });

  it('refuses a proposal id it cannot re-derive', () => {
    const fixture = buildOrganism({ habitat: habitat('bad-proposal') });
    const organism = loadOrganism(fixture.directory);

    expect(() => growOrganism(organism, 'not-a-real-proposal')).toThrow(/does not match any growth/);
  });

  it('refuses to grow an organism that does not verify', () => {
    const fixture = buildOrganism({ habitat: habitat('grow-broken') });
    const asset = join(fixture.directory, 'sonic', 'assets', 'dna-prompt.mid');
    writeFileSync(asset, Buffer.from([0x00]));
    const organism = loadOrganism(fixture.directory);

    expect(() => growOrganism(organism, 'anything')).toThrow(/does not verify/);
  });

  it('keeps history append-only', () => {
    const fixture = buildOrganism({ habitat: habitat('append-only') });
    const organism = loadOrganism(fixture.directory);
    const proposal = buildGrowthProposal(organism, 'sonic').proposal;
    growOrganism(organism, proposal.id, {
      createdAt: '2026-08-20T20:00:00.000Z',
    });

    const replay = buildDimensionFrame({
      rappid: fixture.rappid,
      seq: 0,
      utc: '2026-08-20T21:00:00.000Z',
      prev: null,
      dimension: 'capability',
      version: 1,
      stage: { name: 'baby', ordinal: 0 },
      traits: { evidence_bound: 980 },
      media: {},
    });

    // Index 1 is taken: the chain has moved on, and rewriting it is refused.
    expect(() => appendBodyFrame(loadOrganism(fixture.directory), replay)).toThrow(
      /does not continue/,
    );
  });

  it('stops counting at the first frame that breaks the chain', () => {
    const fixture = buildOrganism({ habitat: habitat('broken-chain') });
    const organism = loadOrganism(fixture.directory);
    const first = buildGrowthProposal(organism, 'sonic').proposal;
    growOrganism(organism, first.id, {
      createdAt: '2026-08-20T20:00:00.000Z',
    });

    const framesDir = join(fixture.directory, 'frames');
    mkdirSync(framesDir, { recursive: true });
    const orphan = buildDimensionFrame({
      rappid: fixture.rappid,
      seq: 1,
      utc: '2026-08-20T22:00:00.000Z',
      prev: 'f'.repeat(64),
      dimension: 'capability',
      version: 1,
      stage: { name: 'hatchling', ordinal: 1 },
      traits: { evidence_bound: 980 },
      media: {},
    });
    writeFileSync(
      join(framesDir, '000001.json'),
      `${JSON.stringify(bodyFrameToJson(orphan), null, 2)}\n`,
    );

    const reloaded = loadOrganism(fixture.directory);
    expect(reloaded.frames).toHaveLength(2);
    expect(contiguousFrameHeight(reloaded.frames)).toBe(1);
    expect(check(reloaded, 'frames.chain').status).toBe('fail');
  });

  it('refuses a hash-valid frame whose dimensional payload shape is invalid', () => {
    const fixture = buildOrganism({ habitat: habitat('payload-refusal') });
    const valid = buildDimensionFrame({
      rappid: fixture.rappid,
      seq: 0,
      utc: '2026-08-20T22:00:00.000Z',
      prev: null,
      dimension: 'sonic',
      version: 1,
      stage: { name: 'baby', ordinal: 0 },
      traits: { evidence_bound: 980 },
      media: {},
    });
    const malformed = {
      ...valid,
      payload: {
        ...valid.payload,
        extra: 'not-lawful',
      },
    } as typeof valid;
    const rehashed = {
      ...malformed,
      payload_hash: '0'.repeat(64),
      frame_hash: '0'.repeat(64),
    };
    expect(() =>
      appendBodyFrame(loadOrganism(fixture.directory), rehashed),
    ).toThrow(/exact key set/);
  });

  it('grows from baby to hatchling as verified frames accumulate', () => {
    const home = habitat('hatchling');
    const fixture = buildOrganism({
      habitat: home,
      extraDimensions: [
        {
          name: 'skill',
          status: 'recorded',
          refs: { manifest: 'skill/SKILL.md' },
          files: { 'skill/SKILL.md': '# Recorded skill\n' },
        },
      ],
    });

    let organism = loadOrganism(fixture.directory);
    expect(summarize(organism, verifyOrganism(organism)).lifecycleStage).toBe('baby');

    organism = loadOrganism(fixture.directory);
    const proposal = buildGrowthProposal(organism, 'sonic').proposal;
    growOrganism(organism, proposal.id, {
      createdAt: '2026-08-20T20:00:00.000Z',
    });
    organism = loadOrganism(fixture.directory);
    const skillBytes = readFileSync(join(fixture.directory, 'skill', 'SKILL.md'));
    const skillHash = storeRappObject(organism, skillBytes);
    expect(skillHash).toMatch(/^[0-9a-f]{64}$/);
    appendBodyFrame(organism, buildDimensionFrame({
      rappid: fixture.rappid,
      seq: 1,
      utc: '2026-08-20T21:00:00.000Z',
      prev: organism.frames[0].payload_hash,
      dimension: 'skill',
      version: 1,
      stage: { name: 'hatchling', ordinal: 1 },
      traits: { evidence_bound: 980 },
      media: { skill: mediaRef(skillBytes, 'text/markdown') },
    }));

    organism = loadOrganism(fixture.directory);
    const summary = summarize(organism, verifyOrganism(organism));
    expect(summary.stats.frameHeight).toBe(2);
    expect(summary.lifecycleStage).toBe('hatchling');
    // Height is presentation over frame height; identity is untouched.
    expect(summary.stats.displayHeightMm).toBe(600);
    expect(summary.rappid).toBe(fixture.rappid);
  });

  it('reaches raptor only with deep history and four active dimensions', () => {
    const fixture = buildOrganism({
      habitat: habitat('raptor'),
      extraDimensions: [
        {
          name: 'skill',
          status: 'recorded',
          refs: { manifest: 'skill/SKILL.md' },
          files: { 'skill/SKILL.md': '# Recorded skill\n' },
        },
        {
          name: 'visual',
          status: 'rendered',
          refs: { sheet: 'visual/sheet.json' },
          files: { 'visual/sheet.json': '{"schema":"quantum-rappid-visual/1.0"}\n' },
        },
      ],
    });

    // A local memory dimension: the engrams are here, not merely referenced.
    const rappidPath = join(fixture.directory, 'rappid.json');
    const document = JSON.parse(readFileSync(rappidPath, 'utf8')) as {
      quantum: { dimensions: Record<string, Record<string, unknown>> };
    };
    document.quantum.dimensions.memory = { status: 'awake', engrams: 'memory/engrams.jsonl' };
    writeFileSync(rappidPath, `${JSON.stringify(document, null, 2)}\n`);
    mkdirSync(join(fixture.directory, 'memory'), { recursive: true });
    writeFileSync(join(fixture.directory, 'memory', 'engrams.jsonl'), '{"cursor":"0002"}\n');

    let organism = loadOrganism(fixture.directory);
    for (let index = 1; index <= 8; index += 1) {
      const dimensions = ['memory', 'skill', 'sonic', 'visual'];
      const dimension = dimensions[(index - 1) % dimensions.length];
      const version = 1 + Math.floor((index - 1) / dimensions.length);
      appendBodyFrame(organism, buildDimensionFrame({
        rappid: fixture.rappid,
        seq: index - 1,
        utc: `2026-08-2${index}T00:00:00.000Z`,
        prev: index === 1 ? null : organism.frames[index - 2].payload_hash,
        dimension,
        version,
        stage: {
          name: index === 8 ? 'raptor' : index >= 2 ? 'hatchling' : 'baby',
          ordinal: index === 8 ? 2 : index >= 2 ? 1 : 0,
        },
        traits: { evidence_bound: 980 },
        media: {},
      }));
    }

    organism = loadOrganism(fixture.directory);
    const report = verifyOrganism(organism);
    const dimensions = dimensionStates(organism, report);
    const stats = deriveStats(organism, report, dimensions);

    expect(report.ok).toBe(true);
    expect(stats.frameHeight).toBe(8);
    expect(dimensions.filter((entry) => entry.status === 'active').map((entry) => entry.name))
      .toEqual(['memory', 'skill', 'sonic', 'visual']);
    expect(deriveStage(stats, dimensions)).toBe('raptor');
    // Frames carry weight of their own, and it is exact.
    expect(stats.residentWeightBytes).toBeGreaterThan(
      fixture.promptMidiBytes + fixture.autocompleteMidiBytes,
    );
  });
});
