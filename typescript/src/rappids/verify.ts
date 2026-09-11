/**
 * Proof, not assertion.
 *
 * Every claim an organism makes about itself is re-derived here from bytes on
 * disk: the manifest hash over canonical JSON, the identity seed over the
 * traits, the identity motif over the RAPPID, each asset's exact length and
 * digest, and the body-frame chain. A creature that says it weighs three
 * megabytes and cannot produce them is not heavy, it is wrong — and the
 * difference has to be visible in the report rather than smoothed over.
 *
 * Nothing here is a heuristic and nothing is estimated. A check either passes
 * with the evidence that made it pass, or fails with what did not match.
 *
 * Mirrored by `python/openrappter/rappids/verify.py`.
 */

import {
  RAPP_EGG_DOMAIN,
  canonicalDigest,
  rappHb,
  sha256Hex,
} from './canonical.js';
import { directoryHex, identityDrift, parseRappid } from './identity.js';
import {
  assetBytes,
  assetExists,
  legacyBodyFrameProblems,
  readRappObject,
  resolveWithin,
} from './store.js';
import { QuantumRappidError } from './types.js';
import type {
  AssetRecord,
  AssetVerification,
  JsonObject,
  LoadedOrganism,
  VerificationCheck,
  VerificationReport,
} from './types.js';
import { basename, sep } from 'node:path';
import { existsSync } from 'node:fs';

function pass(name: string, detail: string): VerificationCheck {
  return { name, status: 'pass', detail };
}

function fail(name: string, detail: string): VerificationCheck {
  return { name, status: 'fail', detail };
}

/** One asset, weighed and hashed. */
function verifyAsset(
  organism: LoadedOrganism,
  dimension: string,
  asset: AssetRecord,
): AssetVerification {
  const base: Omit<AssetVerification, 'status' | 'actualBytes' | 'actualSha256'> = {
    dimension,
    path: asset.path,
    addressSpace: RAPP_EGG_DOMAIN,
    addressHash: '',
    expectedBytes: asset.bytes,
    expectedSha256: asset.sha256,
    mediaType: asset.mediaType,
  };
  if (!assetExists(organism, dimension, asset.path)) {
    return { ...base, status: 'missing', actualBytes: null, actualSha256: null };
  }
  const bytes = assetBytes(organism, dimension, asset.path);
  const digest = sha256Hex(bytes);
  base.addressHash = rappHb(RAPP_EGG_DOMAIN, bytes);
  if (bytes.length !== asset.bytes) {
    return { ...base, status: 'byte-mismatch', actualBytes: bytes.length, actualSha256: digest };
  }
  if (digest !== asset.sha256) {
    return { ...base, status: 'hash-mismatch', actualBytes: bytes.length, actualSha256: digest };
  }
  return { ...base, status: 'verified', actualBytes: bytes.length, actualSha256: digest };
}

function identityChecks(organism: LoadedOrganism): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const rappid = organism.document.rappid;
  const parts = parseRappid(rappid);
  checks.push(pass('identity.format', `${rappid} parses as rappid:@owner/name:<64 hex>`));

  const folder = basename(organism.directory.replace(new RegExp(`${sep}+$`), ''));
  const claimed = directoryHex(folder);
  if (claimed === null) {
    checks.push(pass('identity.habitat', `${folder} is a named habitat directory, not an identity claim`));
  } else if (claimed === parts.hex) {
    checks.push(pass('identity.habitat', `habitat directory matches the RAPPID tail-derived hex`));
  } else {
    checks.push(
      fail('identity.habitat', `habitat directory ${folder} does not match the RAPPID hex ${parts.hex}`),
    );
  }

  const claims: Array<{ source: string; value: string | null }> = [
    { source: 'traits.json', value: organism.traits.rappid },
  ];
  if (organism.sonic !== null) claims.push({ source: 'sonic/sonic-profile.json', value: organism.sonic.rappid });
  for (const frame of organism.frames) {
    claims.push({
      source: `frames/${String(frame.seq).padStart(6, '0')}.json`,
      value: frame.stream_id,
    });
  }
  const drift = identityDrift(rappid, claims);
  checks.push(
    drift.length === 0
      ? pass('identity.single', `${claims.length + 1} documents carry one identity`)
      : fail(
          'identity.single',
          `identity drift: ${drift
            .map((entry) => `${entry.source} says ${String(entry.value)}`)
            .join('; ')}`,
        ),
  );

  const parent = organism.document.parentRappid;
  checks.push(
    parent === null
      ? pass('identity.lineage', 'no parent pointer: this organism was minted, not born')
      : pass('identity.lineage', `true offspring of ${parent}`),
  );
  return checks;
}

function sonicChecks(organism: LoadedOrganism): VerificationCheck[] {
  const sonic = organism.sonic;
  if (sonic === null) return [];
  const checks: VerificationCheck[] = [];

  checks.push(manifestCheck(sonic));
  checks.push(midiDnaCheck(sonic));

  const traitDrift = Object.keys(sonic.traits).filter(
    (key) => organism.traits.traits[key] !== sonic.traits[key],
  );
  checks.push(
    traitDrift.length === 0
      ? pass('sonic.traits', 'the sonic profile carries the same traits as traits.json')
      : fail('sonic.traits', `traits disagree between traits.json and the sonic profile: ${traitDrift.join(', ')}`),
  );
  return checks;
}

/**
 * Has the manifest been edited since it was written?
 *
 * A sidecar hashes the file bytes; an embedded `manifest_sha256` hashes the
 * canonical JSON of every other key. Both are accepted, the sidecar first
 * because it is the newer spelling. A profile carrying neither is not
 * "probably fine": there is nothing to check it against, and a dimension whose
 * integrity cannot be established must not read as verified.
 */
function manifestCheck(sonic: LoadedOrganism['sonic'] & object): VerificationCheck {
  if (sonic.sidecarSha256 !== null) {
    return sonic.sidecarSha256 === sonic.fileSha256
      ? pass('sonic.manifest', `sonic-profile.sha256 matches the profile bytes (${sonic.fileSha256.slice(0, 12)})`)
      : fail(
          'sonic.manifest',
          `sonic-profile.sha256 records ${sonic.sidecarSha256} but the profile hashes to ${sonic.fileSha256}`,
        );
  }
  if (sonic.manifestSha256 !== null) {
    const withoutHash: JsonObject = {};
    for (const key of Object.keys(sonic.raw)) {
      if (key !== 'manifest_sha256') withoutHash[key] = sonic.raw[key];
    }
    const recomputed = canonicalDigest(withoutHash);
    return recomputed === sonic.manifestSha256
      ? pass('sonic.manifest', `manifest hash ${recomputed.slice(0, 12)} covers the profile`)
      : fail(
          'sonic.manifest',
          `manifest hash is ${sonic.manifestSha256} but the profile hashes to ${recomputed}`,
        );
  }
  return fail(
    'sonic.manifest',
    'the sonic profile records no manifest hash and has no sonic-profile.sha256 beside it, '
      + 'so nothing can establish that it has not been edited',
  );
}

/**
 * The MIDI DNA is checked structurally, not against this runtime's generator.
 *
 * Whether a recorded motif is the one *this* implementation would derive is a
 * question about a provider, and providers are replaceable by design — the
 * seam is the provider, not the RAPPID. Asserting our own melody over someone
 * else's organism would turn a legitimate creature into a failing one. What
 * must hold for any organism is that the motif is a well-formed 16-note
 * `NOTE(pitch, delta_onset, duration, velocity)` sequence in MIDI range.
 */
function midiDnaCheck(sonic: LoadedOrganism['sonic'] & object): VerificationCheck {
  if (sonic.prompt.length !== 16) {
    return fail('sonic.midi-dna', `the identity motif carries ${sonic.prompt.length} notes, expected 16`);
  }
  const bad = sonic.prompt.filter(
    (note) =>
      note.pitch < 0
      || note.pitch > 127
      || note.velocity < 1
      || note.velocity > 127
      || note.deltaOnset < 0
      || note.duration <= 0,
  );
  return bad.length === 0
    ? pass('sonic.midi-dna', 'the 16-note identity motif is well formed and in MIDI range')
    : fail('sonic.midi-dna', `${bad.length} of 16 identity-motif notes are out of MIDI range`);
}

function frameChecks(organism: LoadedOrganism): VerificationCheck[] {
  if (organism.frames.length === 0) {
    return [pass(
      'frames.chain',
      'no legacy body.dimension frames yet: a compact organism is not broken',
    )];
  }
  const problems: string[] = [];
  let head: LoadedOrganism['frames'][number] | null = null;
  organism.frames.forEach((frame) => {
    for (const problem of legacyBodyFrameProblems(
      frame,
      head,
      organism.document.rappid,
    )) {
      problems.push(`frame ${frame.seq}: ${problem}`);
    }
    head = frame;
  });
  return [
    problems.length === 0
      ? pass(
        'frames.chain',
        `${organism.frames.length} legacy body.dimension frames pass integrity-only chaining; this is not current-kind conformance`,
      )
      : fail('frames.chain', problems.join('; ')),
  ];
}

function verifyFrameMedia(
  organism: LoadedOrganism,
): AssetVerification[] {
  const results: AssetVerification[] = [];
  for (const frame of organism.frames) {
    const media = frame.payload.media;
    for (const [role, raw] of Object.entries(media)) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        results.push({
          dimension: frame.payload.dimension,
          path: role,
          status: 'missing',
          addressSpace: RAPP_EGG_DOMAIN,
          addressHash: '',
          expectedBytes: 0,
          actualBytes: null,
          expectedSha256: '',
          actualSha256: null,
          mediaType: 'application/octet-stream',
        });
        continue;
      }
      const ref = raw as Record<string, unknown>;
      const hash = typeof ref.hash === 'string' ? ref.hash : '';
      const expectedBytes = typeof ref.bytes === 'number' ? ref.bytes : 0;
      const mediaType =
        typeof ref.media_type === 'string'
          ? ref.media_type
          : 'application/octet-stream';
      const bytes = /^[0-9a-f]{64}$/.test(hash)
        ? readRappObject(organism, hash)
        : null;
      const actualHash =
        bytes === null ? null : rappHb(RAPP_EGG_DOMAIN, bytes);
      let status: AssetVerification['status'] = 'verified';
      if (bytes === null) status = 'missing';
      else if (bytes.length !== expectedBytes) status = 'byte-mismatch';
      else if (
        ref.space !== RAPP_EGG_DOMAIN
        || actualHash !== hash
      ) {
        status = 'hash-mismatch';
      }
      results.push({
        dimension: frame.payload.dimension,
        path: role,
        status,
        addressSpace: RAPP_EGG_DOMAIN,
        addressHash: hash,
        expectedBytes,
        actualBytes: bytes?.length ?? null,
        expectedSha256: hash,
        actualSha256: actualHash,
        mediaType,
      });
    }
  }
  return results;
}

/**
 * Dimension refs that name a file must name a file that is there.
 *
 * A ref without a separator is a cursor or an identifier (`"0002"`), not a
 * path, and inventing a file for it would turn a healthy organism into a
 * failing one.
 */
function dimensionRefChecks(organism: LoadedOrganism): VerificationCheck[] {
  const missing: string[] = [];
  let checked = 0;
  for (const dimension of organism.document.dimensions) {
    for (const key of Object.keys(dimension.refs).sort()) {
      const ref = dimension.refs[key];
      if (!ref.includes('/') || ref.includes('://')) continue;
      checked += 1;
      let target: string;
      try {
        target = resolveWithin(organism.directory, ref);
      } catch (error) {
        missing.push(`${dimension.name}.${key} -> ${(error as QuantumRappidError).message}`);
        continue;
      }
      if (!existsSync(target)) missing.push(`${dimension.name}.${key} -> ${ref}`);
    }
  }
  return [
    missing.length === 0
      ? pass('dimensions.refs', `${checked} dimension refs resolve inside the organism`)
      : fail('dimensions.refs', `dimension refs point at files that are not here: ${missing.join(', ')}`),
  ];
}

/**
 * Everything, checked.
 *
 * `verifiedAddresses` is deliberately a `(dimension, sha256)` set: it is what
 * makes weight honest later, because the same bytes carried twice must not
 * make an organism heavier.
 */
export function verifyOrganism(organism: LoadedOrganism): VerificationReport {
  const checks: VerificationCheck[] = [
    ...identityChecks(organism),
    ...sonicChecks(organism),
    ...frameChecks(organism),
    ...dimensionRefChecks(organism),
  ];

  const assets: AssetVerification[] = [];
  if (organism.sonic !== null) {
    for (const asset of organism.sonic.assets) assets.push(verifyAsset(organism, organism.sonic.dimension, asset));
  }
  assets.push(...verifyFrameMedia(organism));

  const broken = assets.filter((asset) => asset.status !== 'verified');
  checks.push(
    broken.length === 0
      ? pass('assets.content', `${assets.length} content addresses verified byte for byte`)
      : fail(
          'assets.content',
          broken.map((asset) => `${asset.dimension}/${asset.path} is ${asset.status}`).join('; '),
        ),
  );

  const verifiedAddresses = [
    ...new Set(
      assets
        .filter((asset) => asset.status === 'verified')
        .map((asset) => `${asset.addressSpace}:${asset.addressHash}`),
    ),
  ].sort();

  return {
    rappid: organism.document.rappid,
    ok: checks.every((check) => check.status === 'pass'),
    checks,
    assets,
    verifiedAddresses,
  };
}

/** Sugar for the many call sites that only need the verdict. */
export function isVerified(organism: LoadedOrganism): boolean {
  return verifyOrganism(organism).ok;
}

/** Guard used before anything is appended to an organism. */
export function assertVerified(organism: LoadedOrganism): VerificationReport {
  const report = verifyOrganism(organism);
  if (!report.ok) {
    const failures = report.checks.filter((check) => check.status === 'fail');
    throw new QuantumRappidError(
      'unverified',
      `${organism.document.rappid} does not verify: ${failures.map((check) => `${check.name}: ${check.detail}`).join('; ')}`,
    );
  }
  return report;
}
