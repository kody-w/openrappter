import { describe, expect, it } from 'vitest';

import { rappFrameDigest } from './frame.js';
import {
  OPENRAPPTER_EVIDENCE_FRAME_KIND,
  OPENRAPPTER_EVIDENCE_SCHEMA,
  RAPP_REV14_AUTHORITY,
  RappFrameError,
  assertRappEvidenceChain,
  buildOpenRappterEvidencePayload,
  buildRappEvidenceFrame,
  verifyRappEvidenceChain,
  verifyRappEvidenceFrame,
  type OpenRappterEvidenceFrame,
} from './index.js';

const STREAM_ID = `rappid:@example/evidence:${'f'.repeat(64)}`;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('OpenRappter evidence payload profile', () => {
  it('carries application evidence and the exact rev-14 authority identity', () => {
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
      protocol_revision: RAPP_REV14_AUTHORITY,
    });
    expect(payload).not.toHaveProperty('spec');
    expect(payload).not.toHaveProperty('frame_hash');
  });

  it('refuses unsorted, duplicate, or malformed references without repairing them', () => {
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

describe('RAPP/1 evidence frame helpers', () => {
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

  it('builds exact body.pulse frames and verifies the chain', () => {
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
    expect(verifyRappEvidenceFrame(genesis, {
      head: null,
      streamIdOfRecord: STREAM_ID,
    })).toMatchObject({ ok: true });
    const verified = verifyRappEvidenceChain([genesis, child], STREAM_ID);
    expect(verified).toMatchObject({ ok: true, head: child });
    expect(verified.ok && Object.isFrozen(verified.frames)).toBe(true);
    expect(assertRappEvidenceChain([genesis, child], STREAM_ID))
      .toEqual([genesis, child]);
  });

  it('is deterministic and retry-safe for the same head, time, and evidence', () => {
    const retry = buildRappEvidenceFrame({
      streamId: STREAM_ID,
      utc: '2026-08-30T22:00:01.000Z',
      eventKind: 'install.verified',
      subject: 'release:1.0.0',
      dataHash: '2'.repeat(64),
      referenceHashes: [genesis.payload_hash],
      head: genesis,
    });
    expect(retry).toEqual(child);
    expect(retry.frame_hash).toBe(child.frame_hash);
    expect(Object.isFrozen(retry)).toBe(true);
    expect(Object.isFrozen(retry.payload)).toBe(true);
    expect(Object.isFrozen(retry.payload.protocol_revision)).toBe(true);
  });

  it('rejects protocol revision drift even when both frame hashes are recomputed', () => {
    const frame = clone(child);
    frame.payload.protocol_revision.frame_hash = '0'.repeat(64) as typeof frame.payload.protocol_revision.frame_hash;
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

  it('returns typed chain failure evidence for empty and backward chains', () => {
    expect(verifyRappEvidenceChain([], STREAM_ID)).toMatchObject({
      ok: false,
      error: { code: 'empty-chain', step: null },
    });
    const backward = clone(child);
    backward.utc = '2026-08-30T21:59:59.999Z';
    backward.frame_hash = rappFrameDigest(backward);
    expect(verifyRappEvidenceChain([genesis, backward], STREAM_ID))
      .toMatchObject({
        ok: false,
        error: { code: 'time-regression', step: '4', frameIndex: 1 },
      });
  });
});
