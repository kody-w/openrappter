import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  OPENRAPPTER_EVIDENCE_FRAME_KIND,
  OPENRAPPTER_EVIDENCE_SCHEMA,
  RappFrameError,
  assertRappEvidenceChain,
  buildOpenRappterEvidencePayload,
  buildRappEvidenceFrame,
  createOpenRappterEvidenceProfile,
  rappFrameDigest,
  selectRappChainTrustPolicy,
  verifyRappEvidenceChain,
  verifyRappEvidenceFrame,
  type OpenRappterEvidenceFrame,
} from './index.js';

const STREAM_ID = `rappid:@example/evidence:${'f'.repeat(64)}`;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('selected authority evidence payload', () => {
  it('defaults to the immutable owner-ratified rev-14 authority', () => {
    const payload = buildOpenRappterEvidencePayload({
      eventKind: 'install.verified',
      subject: 'release:1.0.0',
      dataHash: 'a'.repeat(64),
      referenceHashes: ['b'.repeat(64), 'c'.repeat(64)],
    });

    expect(payload).toEqual({
      schema: OPENRAPPTER_EVIDENCE_SCHEMA,
      event_kind: 'install.verified',
      subject: 'release:1.0.0',
      data_hash: 'a'.repeat(64),
      reference_hashes: ['b'.repeat(64), 'c'.repeat(64)],
      protocol_revision: {
        revision: 'rev-14',
        frame_hash: ACCEPTED_RAPP_PROTOCOL_AUTHORITY.frameHash,
        payload_hash: ACCEPTED_RAPP_PROTOCOL_AUTHORITY.payloadHash,
      },
    });
    expect(payload).not.toHaveProperty('spec');
    expect(Object.keys(payload)).not.toContain('frame_hash');
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it('accepts only a selected ProtocolAuthority, never draft metadata', () => {
    expect(() => createOpenRappterEvidenceProfile({
      status: 'draft',
      revision: 'rev-15',
      checkpoint: 'unpublished',
    } as never)).toThrow(/selected ProtocolAuthority/);
  });

  it('refuses unsorted, duplicate, malformed, or non-I-JSON payload data', () => {
    expect(() => buildOpenRappterEvidencePayload({
      eventKind: 'install.verified',
      subject: 'release:1.0.0',
      dataHash: 'a'.repeat(64),
      referenceHashes: ['c'.repeat(64), 'b'.repeat(64)],
    })).toThrow(RappFrameError);
    expect(() => buildOpenRappterEvidencePayload({
      eventKind: 'install.verified',
      subject: 'release:1.0.0',
      dataHash: 'a'.repeat(64),
      referenceHashes: ['b'.repeat(64), 'b'.repeat(64)],
    })).toThrow(/sorted and de-duplicated/);
    expect(() => buildOpenRappterEvidencePayload({
      eventKind: 'not registered spacing',
      subject: 'release:1.0.0',
      dataHash: 'a'.repeat(64),
    })).toThrow(/event_kind/);
    expect(() => buildOpenRappterEvidencePayload({
      eventKind: 'install.verified',
      subject: '\ud800',
      dataHash: 'a'.repeat(64),
    })).toThrow(/unpaired surrogate/);
  });
});

describe('RAPP/1 evidence helpers and trust', () => {
  const genesis = buildRappEvidenceFrame({
    streamId: STREAM_ID,
    utc: '2026-08-30T22:00:00.000Z',
    eventKind: 'install.started',
    subject: 'release:1.0.0',
    dataHash: '1'.repeat(64),
    head: null,
  });
  const child = buildRappEvidenceFrame({
    streamId: STREAM_ID,
    utc: '2026-08-30T22:00:01.000Z',
    eventKind: 'install.verified',
    subject: 'release:1.0.0',
    dataHash: '2'.repeat(64),
    referenceHashes: [genesis.payload_hash],
    head: genesis,
  });
  const policy = selectRappChainTrustPolicy({
    trustedGenesis: {
      streamId: STREAM_ID,
      frameHash: genesis.frame_hash,
      payloadHash: genesis.payload_hash,
    },
  });

  it('builds exact immutable body.pulse frames', () => {
    expect(genesis).toMatchObject({
      spec: 'rapp/1',
      kind: OPENRAPPTER_EVIDENCE_FRAME_KIND,
      stream_id: STREAM_ID,
      seq: 0,
      prev: null,
      prev_wave: null,
      sig: null,
    });
    expect(child.seq).toBe(1);
    expect(child.prev).toBe(genesis.payload_hash);
    expect(Object.keys(genesis)).toHaveLength(11);
    expect(Object.isFrozen(genesis)).toBe(true);
    expect(Object.isFrozen(genesis.payload.protocol_revision)).toBe(true);
  });

  it('returns explicit integrity-only, non-promotion trust', () => {
    expect(verifyRappEvidenceFrame(genesis, {
      head: null,
      streamIdOfRecord: STREAM_ID,
    })).toMatchObject({
      ok: true,
      trust: {
        classification: 'integrity-only',
        promotionGrade: false,
        authority: { revision: 'rev-14' },
      },
    });
    const verified = verifyRappEvidenceChain([genesis, child], policy);
    expect(verified).toMatchObject({
      ok: true,
      head: child,
      trust: {
        classification: 'integrity-only',
        promotionGrade: false,
        genesis: 'trusted',
      },
    });
    expect(verified.ok && Object.isFrozen(verified.frames)).toBe(true);
    expect(assertRappEvidenceChain([genesis, child], policy))
      .toEqual([genesis, child]);
  });

  it('is deterministic and retry-safe for identical selected authority and head', () => {
    const retry = buildRappEvidenceFrame({
      streamId: STREAM_ID,
      utc: '2026-08-30T22:00:01.000Z',
      eventKind: 'install.verified',
      subject: 'release:1.0.0',
      dataHash: '2'.repeat(64),
      referenceHashes: [genesis.payload_hash],
      head: genesis,
      authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
    });
    expect(retry).toEqual(child);
    expect(retry.frame_hash).toBe(child.frame_hash);
  });

  it('rejects authority identity drift even after rehashing', () => {
    const frame = clone(child);
    frame.payload.protocol_revision.frame_hash = '0'.repeat(64);
    frame.payload_hash = '0'.repeat(64);
    frame.frame_hash = rappFrameDigest(frame);
    expect(verifyRappEvidenceFrame(frame, {
      head: genesis,
      streamIdOfRecord: STREAM_ID,
    })).toMatchObject({
      ok: false,
      error: { step: '1', code: 'payload-profile' },
    });
  });

  it('rejects payload key additions instead of widening the evidence schema', () => {
    const frame = clone(genesis) as OpenRappterEvidenceFrame;
    (frame.payload as Record<string, unknown>).private_envelope = true;
    frame.payload_hash = '0'.repeat(64);
    frame.frame_hash = rappFrameDigest(frame);
    expect(verifyRappEvidenceFrame(frame, {
      head: null,
      streamIdOfRecord: STREAM_ID,
    })).toMatchObject({
      ok: false,
      error: { step: '1', code: 'payload-profile' },
    });
  });
});
