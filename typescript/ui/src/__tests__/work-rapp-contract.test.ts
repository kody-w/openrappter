// @vitest-environment node
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY, ProtocolAuthority, protocolAuthorityIdentity,
} from '../../../src/rapp/authority.js';
import {
  RAPP_ACCEPTED_BODY_PULSE_PROFILE, RAPP_FRAME_KEYS, selectRappChainTrustPolicy,
  verifyRappFrameJson, rappFrameWavePreimage, buildRappFrame,
} from '../../../src/rapp/frame.js';
import { rappCanonicalJson, rappH, RAPP_PARTICLE_DOMAIN } from '../../../src/rappids/canonical.js';
import {
  WORK_FRAME_BINDINGS, workFrameBasis, workSubject, workJsonObject,
  type WorkProjectionClaim, type WorkCommitRequest, type WorkRappScan,
} from '../../../src/rapp/work-contract.js';
import { assertWorkCommitPrecondition, scanWorkProjection, scanWorkCommit } from '../../../src/rapp/work-verification.js';
import { verifyWorkScan, WorkRappClient, isWorkVerified } from '../services/work-rapp.js';
import { WorkFrameFixture, framedGateway } from './fixtures/work-rapp-fixture.js';

const claim: WorkProjectionClaim = {
  scope: 'workspace', subject: workSubject('workspace', 'finance'),
  data: { id: 'finance', agentId: 'Finance', rootPath: '/work/finance', isolation: 'dedicated' },
};
const vmClaim: WorkProjectionClaim = {
  scope: 'vm', subject: 'vm:omarchy',
  data: { id: 'omarchy', name: 'Omarchy', state: 'stopped', local: true },
};
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('real RAPP/1 canonical frame integration', () => {
  it('scans the real selected rev-14 authority bytes and independently recomputes particle/wave hashes', () => {
    const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../src/rapp/__fixtures__/rev14-authority.json'), 'utf8'));
    const raw = rappCanonicalJson(fixture.frame);
    const scanned = verifyRappFrameJson(raw, RAPP_ACCEPTED_BODY_PULSE_PROFILE, {
      head: fixture.predecessor, streamIdOfRecord: fixture.frame.stream_id,
    });
    expect(scanned.ok).toBe(true);
    if (!scanned.ok) throw scanned.error;
    expect(Buffer.byteLength(raw)).toBe(fixture.expected.frame_canonical_bytes);
    expect(createHash('sha256').update(raw).digest('hex')).toBe(fixture.expected.frame_canonical_sha256);
    expect(createHash('sha256').update(`rapp/1:particle\n${rappCanonicalJson(scanned.frame.payload)}`).digest('hex'))
      .toBe(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.payloadHash);
    expect(createHash('sha256').update(`rapp/1:wave\n${rappCanonicalJson(rappFrameWavePreimage(scanned.frame))}`).digest('hex'))
      .toBe(ACCEPTED_RAPP_PROTOCOL_AUTHORITY.frameHash);
    expect(scanned.trust).toMatchObject({ classification: 'integrity-only', promotionGrade: false, authority: { revision: 'rev-14' } });
  });

  it.each(['agent', 'workspace', 'vm', 'approval', 'message', 'evidence', 'run', 'task'] as const)(
    'maps %s to registered memory/body frames without another event envelope',
    async (scope) => {
      const fixture = new WorkFrameFixture();
      const projection: WorkProjectionClaim = { scope, subject: workSubject(scope, 'example'), data: { label: 'Fixture value' } };
      const scan = fixture.prove(projection);
      const source = scan.memory.frames.find((frame) => frame.frame_hash === scan.source_frame_hash)!;
      const evidence = scan.body.frames.find((frame) => frame.frame_hash === scan.evidence_frame_hash)!;
      expect(source.kind).toBe(WORK_FRAME_BINDINGS[scope].kinds[0]);
      expect(evidence.kind).toBe('body.pulse');
      expect(evidence.payload.schema).toBe('openrappter-evidence/1');
      expect(evidence.payload.data_hash).toBe(rappH(RAPP_PARTICLE_DOMAIN, projection.data));
      expect(evidence.payload.reference_hashes).toContain(source.payload_hash);
      expect(evidence.payload.reference_hashes).toContain(source.frame_hash);
      expect(Object.keys(source).sort()).toEqual([...RAPP_FRAME_KEYS].sort());
      expect(Object.keys(evidence).sort()).toEqual([...RAPP_FRAME_KEYS].sort());
      expect(isWorkVerified(await verifyWorkScan(projection, scan))).toBe(true);
    },
  );

  it('requires store-selected committed heads and does not trust caller-shaped policies or draft authorities', () => {
    const fixture = new WorkFrameFixture();
    fixture.prove(claim);
    const proof = fixture.proof(claim.subject);
    const selection = fixture.selection(claim.subject);
    expect(() => scanWorkProjection(claim, proof, { ...selection, subject: 'workspace:someone-else' })).toThrow(/different Work subject/);
    expect(() => scanWorkProjection(claim, proof, {
      ...selection, body: selectRappChainTrustPolicy({ trustedGenesis: selection.body.trustedGenesis }),
    })).toThrow(/committed head/);
    expect(() => scanWorkProjection(claim, proof, {
      ...selection, memory: { ...selection.memory } as never,
    })).toThrow(/authority|policy/);
    expect(() => scanWorkProjection(claim, proof, {
      ...selection, body: selectRappChainTrustPolicy({
        authority: ProtocolAuthority.acceptedRev13,
        trustedGenesis: selection.body.trustedGenesis, persistedHead: selection.body.persistedHead,
      }),
    })).toThrow(/selected authority/);
  });

  it('refuses tampered canonical bytes, missing lineage, and wrong families', () => {
    const fixture = new WorkFrameFixture();
    fixture.prove(claim);
    const proof = fixture.proof(claim.subject);
    const selection = fixture.selection(claim.subject);
    const changed = clone(proof);
    const source = JSON.parse(changed.memory[1]);
    source.payload.data.rootPath = '/other/workspace';
    changed.memory[1] = rappCanonicalJson(source);
    expect(() => scanWorkProjection(claim, changed, selection)).toThrow(/payload_hash|payload hash/);
    expect(() => scanWorkProjection(claim, { ...proof, memory: proof.memory.slice(1) }, selection)).toThrow(/genesis|seq|predecessor/);
    expect(() => scanWorkProjection(claim, { ...proof, memory: proof.body }, selection)).toThrow(/family|stream|kind/);
    expect(() => scanWorkProjection(claim, { ...proof, body: [` ${proof.body[0]}`, ...proof.body.slice(1)] }, selection)).toThrow(/exact canonical/);
  });

  it('refuses valid-looking but uncommitted, rolled-back, or superseded projections', () => {
    const fixture = new WorkFrameFixture();
    fixture.prove(claim);
    const old = fixture.proof(claim.subject);
    const oldSelection = fixture.selection(claim.subject);
    fixture.prove({ ...claim, data: { ...claim.data, rootPath: '/work/new' } });
    const current = fixture.proof(claim.subject);
    expect(() => scanWorkProjection(claim, old, fixture.selection(claim.subject))).toThrow(/below persisted|rollback/);
    expect(() => scanWorkProjection(claim, current, oldSelection)).toThrow(/committed head/);
    expect(() => scanWorkProjection(claim, {
      ...current, source_frame_hash: old.source_frame_hash, evidence_frame_hash: old.evidence_frame_hash,
    }, fixture.selection(claim.subject))).toThrow(/superseded/);
  });

  it('preserves evidence-particle uniqueness even when replayed frames have valid new wave hashes', async () => {
    const fixture = new WorkFrameFixture();
    const scan = fixture.prove(claim);
    const replay = buildRappFrame({
      kind: 'body.pulse', streamId: scan.body.head.stream_id, utc: '2026-09-12T00:00:00.000Z',
      payload: scan.body.head.payload, head: scan.body.head,
    }, RAPP_ACCEPTED_BODY_PULSE_PROFILE);
    const forged = clone(scan);
    forged.body.frames = [...forged.body.frames, replay];
    forged.body.head = replay;
    forged.evidence_frame_hash = replay.frame_hash;
    await expect(verifyWorkScan(claim, forged)).rejects.toThrow(/Duplicate RAPP\/1 evidence particle/);
  });

  it('binds distinct frame occurrences when a workspace returns to an earlier state value', async () => {
    const fixture = new WorkFrameFixture();
    const initial = fixture.prove(claim);
    fixture.prove({ ...claim, data: { ...claim.data, rootPath: '/work/changed' } });
    const returned = fixture.prove(claim);
    expect(returned.memory.head.payload_hash).toBe(initial.memory.head.payload_hash);
    expect(returned.memory.head.frame_hash).not.toBe(initial.memory.head.frame_hash);
    expect(returned.body.head.payload_hash).not.toBe(initial.body.head.payload_hash);
    expect(isWorkVerified(await verifyWorkScan(claim, returned))).toBe(true);
  });
});

describe('canonical Work mutation contract', () => {
  it.each(['vm.start', 'vm.stop', 'exec.respond'] as const)('requires an append-only write-ahead intent and result for %s', async (method) => {
    const fixture = new WorkFrameFixture();
    const before: WorkProjectionClaim = method === 'exec.respond'
      ? { scope: 'approval', subject: 'approval:approval-1', data: { id: 'approval-1', command: 'save draft', status: 'pending' } }
      : { ...vmClaim, data: { ...vmClaim.data, state: method === 'vm.stop' ? 'running' : 'stopped' } };
    const initial = fixture.prove(before);
    const request: WorkCommitRequest = {
      method, subject: before.subject,
      params: method === 'exec.respond' ? { approvalId: 'approval-1', approved: true } : {},
      basis: workFrameBasis(initial),
    };
    expect(() => assertWorkCommitPrecondition(request, clone(initial))).toThrow(/real canonical scan/);
    const intent = fixture.prepare(request);
    const data = method === 'exec.respond'
      ? { ok: true, approvalId: 'approval-1', approved: true, status: 'approved' }
      : { ...vmClaim.data, state: method === 'vm.start' ? 'starting' : 'stopped' };
    const response = fixture.complete(request, data, intent);
    const receipt = await verifyWorkScan({
      scope: method === 'exec.respond' ? 'approval-decision' : 'vm', subject: request.subject, data,
    }, response.scan, request);
    expect(isWorkVerified(receipt)).toBe(true);
    expect(response.scan.memory.head.seq).toBe(initial.memory.head.seq + 2);
    expect(response.scan.memory.frames.find((frame) => frame.frame_hash === intent.frame_hash)?.payload.data)
      .toEqual({ phase: 'accepted' });
    expect(response.scan.body.head.payload.reference_hashes).toContain(intent.payload_hash);
    expect(response.scan.memory.head.payload.outcome).toBe('success');
    expect(response.scan.memory.head.payload.request).toEqual(request);
  });

  it('rejects stale preconditions and request substitution before an action can be certified', () => {
    const fixture = new WorkFrameFixture();
    const scan = fixture.prove(vmClaim);
    const request: WorkCommitRequest = { method: 'vm.start', subject: 'vm:omarchy', params: {}, basis: workFrameBasis(scan) };
    expect(() => assertWorkCommitPrecondition({
      ...request, basis: { ...request.basis, source_frame_hash: 'f'.repeat(64) },
    }, scan)).toThrow(/heads changed/);
    const intent = fixture.prepare(request);
    const data = { ...vmClaim.data, state: 'starting' };
    fixture.complete(request, data, intent);
    expect(() => scanWorkCommit({ ...request, method: 'vm.stop' }, data, fixture.proof('vm:omarchy'), fixture.selection('vm:omarchy')))
      .toThrow(/exact request/);
  });

  it('returns the same frame IDs on an idempotent retry rather than another action', async () => {
    const execute = vi.fn().mockResolvedValue({ ...vmClaim.data, state: 'starting' });
    const transport = framedGateway(execute);
    const initial = await transport('work.rapp.verify', { ...vmClaim }) as WorkRappScan;
    const request: WorkCommitRequest = { method: 'vm.start', subject: 'vm:omarchy', params: {}, basis: workFrameBasis(initial) };
    const a = await transport('work.rapp.commit', { ...request });
    const b = await transport('work.rapp.commit', { ...request });
    expect(a).toEqual(b);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('frames failed actions as failures and never treats them as successful VM transitions', async () => {
    const transport = framedGateway(async () => { throw new Error('VM backend refused startup'); });
    const client = new WorkRappClient({ call: vi.fn(transport) });
    expect(isWorkVerified(await client.verify(vmClaim))).toBe(true);
    await expect(client.commit('vm.start', 'vm:omarchy', {})).rejects.toMatchObject({
      message: 'VM backend refused startup',
      rapp: { state: 'verified', scan: { memory: { head: { payload: { outcome: 'error' } } } } },
    });
  });
});

describe('browser-side RAPP/1 integrity boundary', () => {
  it.each([
    ['payload hash', (scan: WorkRappScan) => { scan.memory.frames[1].payload_hash = 'f'.repeat(64); }],
    ['wave hash', (scan: WorkRappScan) => { scan.body.frames[1].frame_hash = 'f'.repeat(64); }],
    ['authority', (scan: WorkRappScan) => { scan.body.trust = { ...scan.body.trust, authority: { ...protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY), revision: 'draft' } }; }],
    ['genesis', (scan: WorkRappScan) => { scan.memory.trust = { ...scan.memory.trust, genesis: 'unbound' }; }],
    ['persistence', (scan: WorkRappScan) => { scan.body.trust = { ...scan.body.trust, persistedHead: 'untracked' }; }],
    ['lineage', (scan: WorkRappScan) => { scan.memory.frames[1].prev = null; }],
    ['stream family', (scan: WorkRappScan) => { scan.memory.frames[1].kind = 'swarm.telemetry'; }],
    ['head', (scan: WorkRappScan) => { scan.memory.head = scan.memory.frames[0]; }],
  ] as const)('refuses %s drift instead of showing a verified badge', async (_name, mutate) => {
    const fixture = new WorkFrameFixture();
    const raw = clone(fixture.prove(claim));
    mutate(raw);
    await expect(verifyWorkScan(claim, raw)).rejects.toThrow();
  });

  it('does not certify substituted display data or forged verification booleans', async () => {
    const fixture = new WorkFrameFixture();
    const scan = fixture.prove(claim);
    await expect(verifyWorkScan({ ...claim, data: { ...claim.data, isolation: 'shared' } }, scan)).rejects.toThrow(/displayed data/);
    await expect(verifyWorkScan(claim, { verified: true, compliant: true })).rejects.toThrow();
    expect(isWorkVerified({ state: 'verified', detail: 'claimed', scan })).toBe(false);
  });

  it('does not bless a lookalike receipt if WeakSet prototypes are changed after import', () => {
    const fixture = new WorkFrameFixture();
    const scan = fixture.prove(claim);
    const spy = vi.spyOn(WeakSet.prototype, 'has').mockReturnValue(true);
    try {
      expect(isWorkVerified({ state: 'verified', detail: 'claimed', scan })).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('never submits mutations without verified evidence and never falls back to legacy RPCs', async () => {
    const call = vi.fn().mockRejectedValue(Object.assign(new Error('Method not found: work.rapp.verify'), { code: -32601 }));
    const client = new WorkRappClient({ call });
    expect((await client.verify(vmClaim)).state).toBe('unavailable');
    await expect(client.commit('vm.start', 'vm:omarchy', {})).rejects.toThrow('Nothing was submitted');
    expect(call.mock.calls).toHaveLength(1);
    expect(call.mock.calls[0][0]).toBe('work.rapp.verify');
  });

  it.each([
    { ...vmClaim, data: { ...vmClaim.data, local: false } },
    { ...vmClaim, data: { ...vmClaim.data, state: 'running' } },
  ])('does not confuse verified bytes with VM action eligibility', async (projection) => {
    const fixture = new WorkFrameFixture();
    const call = vi.fn().mockResolvedValue(fixture.prove(projection));
    const client = new WorkRappClient({ call });
    expect(isWorkVerified(await client.verify(projection))).toBe(true);
    await expect(client.commit('vm.start', 'vm:omarchy', {})).rejects.toThrow(/expected state.*local Omarchy/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('tracks observed heads to reject rollback and drops proofs on reconnect', async () => {
    const fixture = new WorkFrameFixture();
    const original = fixture.prove(claim);
    const updatedClaim = { ...claim, data: { ...claim.data, rootPath: '/new' } };
    const updated = fixture.prove(updatedClaim);
    const call = vi.fn().mockResolvedValueOnce(updated).mockResolvedValueOnce(original);
    const client = new WorkRappClient({ call });
    expect(isWorkVerified(await client.verify(updatedClaim))).toBe(true);
    expect(await client.verify(claim)).toMatchObject({ state: 'invalid', detail: expect.stringMatching(/rollback|fork/) });
    client.reset();
    await expect(client.commit('vm.start', 'vm:omarchy', {})).rejects.toThrow('Nothing was submitted');
  });
});
