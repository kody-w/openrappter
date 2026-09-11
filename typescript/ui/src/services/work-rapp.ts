import type { GatewayClient } from './gateway.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY, protocolAuthorityFamilyForKind, protocolAuthorityIdentity,
} from '../../../src/rapp/authority.js';
import {
  RAPP_FRAME_KEYS, RAPP_FRAME_SPEC, RAPP_UINT53_MAX, isRappFrameUtc,
  rappStreamFamily, rappFrameWavePreimage,
} from '../../../src/rapp/wire.js';
import { RAPP_PARTICLE_DOMAIN, RAPP_WAVE_DOMAIN, rappCanonicalJson } from '../../../src/rapp/json.js';
import {
  assertWorkScanBindings, sameWorkValue, workFrameHead, workFrameBasis, workCommitClaim, workJsonObject, workScanRequest, assertWorkActionState,
  type WorkProjectionClaim, type WorkRappScan, type WorkScannedChain, type WorkCommitRequest,
} from '../../../src/rapp/work-contract.js';
import type { RappFrame, RappFrameHead } from '../../../src/rapp/frame.js';
import type { JsonObject, JsonValue } from '../../../src/rappids/types.js';

export type WorkVerification =
  | { state: 'verified'; detail: string; scan: WorkRappScan }
  | { state: 'unverified' | 'unavailable' | 'invalid'; detail: string };

const verified = new WeakSet<object>();
const rememberVerified = verified.add.bind(verified);
const hasVerified = verified.has.bind(verified);
const HEX64 = /^[0-9a-f]{64}$/;

export function isWorkVerified(value: WorkVerification | undefined): value is Extract<WorkVerification, { state: 'verified' }> {
  return !!value && hasVerified(value);
}

export function unverifiedWork(): WorkVerification {
  return { state: 'unverified', detail: 'No scanned RAPP/1 frame evidence was supplied. This is a derived, unverified view.' };
}

export class WorkCommitFailure extends Error {
  constructor(message: string, readonly rapp: Extract<WorkVerification, { state: 'verified' }>) {
    super(message);
    this.name = 'WorkCommitFailure';
  }
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

async function hash(space: string, value: JsonValue): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is unavailable; RAPP/1 integrity cannot be checked here.');
  const bytes = new TextEncoder().encode(`${space}\n${rappCanonicalJson(value)}`);
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function frame(value: unknown): RappFrame {
  const item = workJsonObject(value);
  if (Object.keys(item).length !== RAPP_FRAME_KEYS.length || RAPP_FRAME_KEYS.some((key) => !Object.hasOwn(item, key))
    || item.spec !== RAPP_FRAME_SPEC || typeof item.kind !== 'string'
    || typeof item.stream_id !== 'string' || typeof item.seq !== 'number'
    || !Number.isSafeInteger(item.seq) || item.seq < 0 || item.seq > RAPP_UINT53_MAX
    || !isRappFrameUtc(item.utc) || typeof item.payload_hash !== 'string' || !HEX64.test(item.payload_hash)
    || typeof item.frame_hash !== 'string' || !HEX64.test(item.frame_hash)
    || (item.prev !== null && (typeof item.prev !== 'string' || !HEX64.test(item.prev)))
    || item.prev_wave !== null || item.sig !== null || item.kind.endsWith('.re-genesis')) {
    throw new Error('Invalid RAPP/1 frame shape or unsupported trust profile.');
  }
  return {
    spec: RAPP_FRAME_SPEC, kind: item.kind, stream_id: item.stream_id, seq: item.seq,
    utc: item.utc, payload: workJsonObject(item.payload), payload_hash: item.payload_hash,
    frame_hash: item.frame_hash, prev: item.prev, prev_wave: null, sig: null,
  };
}

async function chain(value: unknown, family: 'body' | 'memory'): Promise<WorkScannedChain> {
  const item = workJsonObject(value);
  if (Object.keys(item).sort().join(',') !== 'frames,head,ok,trust' || item.ok !== true || !Array.isArray(item.frames) || !item.frames.length) {
    throw new Error('RAPP/1 scan contains no verified frames or has unexpected fields.');
  }
  const trust = workJsonObject(item.trust);
  const authority = protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
  if (Object.keys(trust).sort().join(',') !== 'authority,classification,genesis,persistedHead,promotionGrade'
    || trust.classification !== 'integrity-only' || trust.promotionGrade !== false
    || trust.genesis !== 'trusted' || trust.persistedHead !== 'matched' || !sameWorkValue(trust.authority, authority)) {
    throw new Error('RAPP/1 scan lacks the selected authority, trusted genesis, or committed head.');
  }
  const frames = item.frames.map(frame);
  const stream = frames[0].stream_id;
  if (rappStreamFamily(stream) !== family) throw new Error('Wrong RAPP/1 stream family.');
  for (let index = 0; index < frames.length; index++) {
    const current = frames[index];
    const previous = frames[index - 1];
    if (current.stream_id !== stream || current.seq !== index
      || protocolAuthorityFamilyForKind(ACCEPTED_RAPP_PROTOCOL_AUTHORITY, current.kind) !== family
      || current.prev !== (previous?.payload_hash ?? null)
      || (previous && current.utc < previous.utc)) throw new Error('RAPP/1 lineage, kind, or ordering is invalid.');
    const [particle, wave] = await Promise.all([
      hash(RAPP_PARTICLE_DOMAIN, current.payload),
      hash(RAPP_WAVE_DOMAIN, rappFrameWavePreimage(current)),
    ]);
    if (particle !== current.payload_hash || wave !== current.frame_hash) throw new Error('RAPP/1 payload or frame hash mismatch.');
  }
  const head = frame(item.head);
  if (!sameWorkValue(head, frames[frames.length - 1])) throw new Error('RAPP/1 head does not match the scanned stream.');
  return {
    ok: true, frames, head,
    trust: { classification: 'integrity-only', promotionGrade: false, authority, genesis: 'trusted', persistedHead: 'matched' },
  };
}

/** Checks bytes locally; the authenticated gateway remains the genesis/persistence trust boundary. */
export async function verifyWorkScan(
  claim: WorkProjectionClaim,
  value: unknown,
  request?: WorkCommitRequest,
): Promise<Extract<WorkVerification, { state: 'verified' }>> {
  const raw = workJsonObject(JSON.parse(rappCanonicalJson(workJsonObject(value))));
  if (Object.keys(raw).sort().join(',') !== 'body,evidence_frame_hash,memory,source_frame_hash') {
    throw new Error('RAPP/1 proof must contain canonical scans, not another evidence envelope.');
  }
  const [body, memory] = await Promise.all([chain(raw.body, 'body'), chain(raw.memory, 'memory')]);
  if (typeof raw.source_frame_hash !== 'string' || typeof raw.evidence_frame_hash !== 'string') {
    throw new Error('RAPP/1 scan is missing source/evidence frame references.');
  }
  const scan: WorkRappScan = { body, memory, source_frame_hash: raw.source_frame_hash, evidence_frame_hash: raw.evidence_frame_hash };
  const command = workScanRequest(scan, request);
  assertWorkScanBindings(claim, scan, await hash(RAPP_PARTICLE_DOMAIN, claim.data), command,
    command ? await hash(RAPP_PARTICLE_DOMAIN, workJsonObject(command)) : undefined);
  const result = freezeTree({
    state: 'verified' as const,
    detail: 'Hashes and lineage checked here. Genesis and committed heads are selected by the gateway. Unsigned local integrity only; not promotion-grade or proof of source truth.',
    scan,
  });
  rememberVerified(result);
  return result;
}

export class WorkRappClient {
  private unavailable = '';
  private probing: Promise<void> | null = null;
  private probed = false;
  private generation = 0;
  private claims = new Map<string, Extract<WorkVerification, { state: 'verified' }>>();
  private heads = new Map<string, RappFrameHead>();

  constructor(private readonly client: Pick<GatewayClient, 'call'>) {}

  reset() {
    this.generation++;
    this.unavailable = '';
    this.probing = null;
    this.probed = false;
    this.claims.clear();
    this.heads.clear();
  }

  private remember(result: Extract<WorkVerification, { state: 'verified' }>, subject: string) {
    for (const scan of [result.scan.body, result.scan.memory]) {
      const previous = this.heads.get(scan.head.stream_id);
      if (previous && !scan.frames.some((candidate) => sameWorkValue(workFrameHead(candidate), previous))) {
        throw new Error('RAPP/1 rollback or fork conflicts with a previously verified head.');
      }
    }
    for (const scan of [result.scan.body, result.scan.memory]) this.heads.set(scan.head.stream_id, workFrameHead(scan.head));
    this.claims.set(subject, result);
  }

  async verify(claim: WorkProjectionClaim): Promise<WorkVerification> {
    const generation = this.generation;
    if (this.probing) await this.probing;
    if (generation !== this.generation) return unverifiedWork();
    if (this.unavailable) return { state: 'unavailable', detail: this.unavailable };
    const check = async (): Promise<WorkVerification> => {
      this.claims.delete(claim.subject);
      try {
        const result = await verifyWorkScan(claim, await this.client.call<WorkRappScan>('work.rapp.verify', {
          scope: claim.scope, subject: claim.subject, data: claim.data,
        }));
        if (generation !== this.generation) return unverifiedWork();
        this.remember(result, claim.subject);
        return result;
      } catch (error) {
        if (generation !== this.generation) return unverifiedWork();
        const failure = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
        if (failure.code === -32601 || (failure.code === undefined
          && (failure.message === 'Method not found: work.rapp.verify' || failure.message === 'Unknown method: work.rapp.verify'))) {
          this.unavailable = 'The gateway has no work.rapp.verify adapter. RAPP/1 verification and Work mutations are unavailable.';
          return { state: 'unavailable', detail: this.unavailable };
        }
        return { state: 'invalid', detail: error instanceof Error ? error.message : String(error) };
      }
    };
    const pending = check();
    if (!this.probed) {
      this.probed = true;
      this.probing = pending.then(() => {});
      await this.probing;
      if (generation === this.generation) this.probing = null;
    }
    return pending;
  }

  async commit(
    method: WorkCommitRequest['method'], subject: string, params: JsonObject,
    decode: (value: unknown) => JsonObject = workJsonObject,
  ): Promise<{ data: JsonObject; rapp: WorkVerification }> {
    const current = this.claims.get(subject);
    if (!isWorkVerified(current)) throw new Error('RAPP/1 verified frame evidence is required before this action. Nothing was submitted.');
    const generation = this.generation;
    const request: WorkCommitRequest = { method, subject, params, basis: workFrameBasis(current.scan) };
    const before = current.scan.memory.frames.find((entry) => entry.frame_hash === current.scan.source_frame_hash)!;
    assertWorkActionState(request, workJsonObject(before.payload.data));
    const response = workJsonObject(await this.client.call('work.rapp.commit', { ...request }));
    if (Object.keys(response).sort().join(',') !== 'data,scan') throw new Error('Invalid canonical Work action response.');
    const data = workJsonObject(response.data);
    const result = await verifyWorkScan(workCommitClaim(request, data), response.scan, request);
    if (generation !== this.generation) throw new Error('Connection changed before RAPP/1 confirmation. Do not retry the operation automatically.');
    const receipt = result.scan.memory.frames.find((entry) => entry.frame_hash === result.scan.source_frame_hash)!;
    if (receipt.payload.outcome === 'error') {
      this.remember(result, subject);
      throw new WorkCommitFailure(String(receipt.payload.error), result);
    }
    if (!sameWorkValue(decode(data), data)) throw new Error('RAPP/1 action data does not match the displayed projection.');
    this.remember(result, subject);
    return { data, rapp: result };
  }
}
