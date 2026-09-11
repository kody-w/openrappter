import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  RAPP_ACCEPTED_BODY_PULSE_PROFILE,
  RAPP_ACCEPTED_BODY_STREAM_PROFILE,
  RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  buildRappFrame,
  createRappFrameProfile,
  protocolAuthorityIdentity,
  rappChainTrustAuthority,
  rappFrameToJson,
  selectRappChainTrustPolicy,
  verifyRappFrameChain,
  verifyRappFrameJson,
  type ProtocolAuthorityIdentity,
  type RappChainTrustPolicy,
  type RappFrame,
  type RappFrameHead,
  type RappFrameVerification,
  type RappTrustAssessment,
} from '../rapp/index.js';
import { RAPP_PARTICLE_DOMAIN, rappCanonicalJson, rappH } from '../rappids/canonical.js';
import type { JsonObject } from '../rappids/types.js';
import { VmError, type VmWorkspaceIdentity } from './types.js';

/**
 * Host-owned canonical persistence, not a VM event store.
 *
 * selectStream supplies independently trusted, already-persisted genesis/head
 * pins. Never derive trust from readStream's candidate bytes. appendFrame is a
 * durable compare-and-append (including the host's highest-head checkpoint),
 * idempotent for identical bytes, and refuses conflicting heads/overwrites.
 * Reads return complete canonical frame JSON strings, in append order.
 * Cancellation must never acknowledge a write that is not durable.
 */
export interface VmRappPersistence {
  selectStream(
    family: 'body' | 'memory',
    identity: VmWorkspaceIdentity | null,
    signal: AbortSignal,
  ): Promise<RappChainTrustPolicy>;
  readStream(streamId: string, signal: AbortSignal): Promise<readonly string[]>;
  appendFrame(
    canonicalFrame: string,
    expectedHead: Readonly<RappFrameHead>,
    signal: AbortSignal,
  ): Promise<void>;
}

/** A derived verification view, never a durable event or a substitute for frames. */
export interface VmRappVerification {
  protocol: 'rapp/1';
  status: 'not-wired' | 'unverified' | 'pending' | 'verified' | 'failed';
  authority: Readonly<ProtocolAuthorityIdentity>;
  scannedFrames: number;
  trust: RappTrustAssessment | null;
  error?: string;
}

type VmEvent =
  | 'vm.requested' | 'vm.completed' | 'vm.failed' | 'vm.cancelled'
  | 'vm.state' | 'vm.spawned' | 'vm.exited' | 'vm.ready' | 'vm.shutdown'
  | 'workspace.requested' | 'workspace.resolved' | 'workspace.failed'
  | 'tool.requested' | 'tool.completed' | 'tool.failed';

const COMPONENT = 'rapp-work.omarchy';
const MEMORY_TOOL_PROFILE = createRappFrameProfile({
  name: 'rapp-work-omarchy-tool-call',
  kind: 'memory.tool-call',
  authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
});
const BODY_EVENTS = new Set<VmEvent>([
  'vm.requested', 'vm.completed', 'vm.failed', 'vm.cancelled',
  'vm.state', 'vm.spawned', 'vm.exited', 'vm.ready', 'vm.shutdown',
  'workspace.requested', 'workspace.resolved', 'workspace.failed',
]);
const TOOL_EVENTS = new Set<VmEvent>(['tool.requested', 'tool.completed', 'tool.failed']);

interface StreamContext {
  policy: RappChainTrustPolicy;
  knownPolicy: RappChainTrustPolicy;
  family: 'body' | 'memory';
  frames: readonly RappFrame[];
  trust: RappTrustAssessment | null;
}

export function vmDataHash(data: JsonObject): string {
  return rappH(RAPP_PARTICLE_DOMAIN, data);
}

function frameBytes(frame: RappFrame): string {
  return rappCanonicalJson(rappFrameToJson(frame));
}

export function vmFrameReference(frame: RappFrame): JsonObject {
  return { stream_id: frame.stream_id, frame_hash: frame.frame_hash, payload_hash: frame.payload_hash };
}

function frameHead(frame: RappFrame): RappFrameHead {
  return {
    stream_id: frame.stream_id, seq: frame.seq, utc: frame.utc,
    payload_hash: frame.payload_hash, frame_hash: frame.frame_hash,
  };
}

function failure(): VmError {
  return new VmError(
    'rapp_verification_failed',
    'Canonical RAPP/1 persistence or verification failed. An acknowledged intent may have an unresolved outcome; reconcile the host stream before retrying.',
  );
}

/** Builds and scans canonical frames; the host, not this adapter, owns storage. */
export class VmRappEvidence {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private fault?: VmError;
  private contexts = new Map<string, StreamContext>();
  private bindings = new Map<string, string>();

  constructor(
    private readonly persistence?: VmRappPersistence,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 2_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
      throw new TypeError('RAPP persistence timeout must be 1-10000ms');
    }
  }

  get wired(): boolean { return this.persistence !== undefined; }
  get healthy(): boolean { return this.wired && !this.fault; }

  assertWritable(): void {
    if (!this.persistence) {
      throw new VmError('rapp_not_wired', 'Host RAPP/1 frame persistence is not wired; VM mutations are disabled.');
    }
    if (this.fault) throw this.fault;
  }

  verification(): VmRappVerification {
    const contexts = [...this.contexts.values()];
    const scannedFrames = contexts.reduce((total, context) => total + context.frames.length, 0);
    const trust = contexts.find((context) => context.trust)?.trust;
    return {
      protocol: 'rapp/1',
      status: !this.wired ? 'not-wired' : this.fault ? 'failed' : this.pending ? 'pending'
        : this.frames().length > 0 ? 'verified' : 'unverified',
      authority: protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY),
      scannedFrames,
      trust: trust ? { ...trust, authority: trust.authority ? { ...trust.authority } : null } : null,
      ...(this.fault ? { error: this.fault.message } : {}),
    };
  }

  /** Bounded derived history. Only scanned canonical frames enter this view. */
  frames(): readonly RappFrame[] {
    return [...this.contexts.values()].flatMap((context) =>
      context.frames.filter((frame) => frame.payload.component === COMPONENT),
    ).sort((a, b) => a.utc.localeCompare(b.utc) || a.stream_id.localeCompare(b.stream_id) || a.seq - b.seq).slice(-100);
  }

  private enqueue<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try { this.assertWritable(); } catch (error) { return Promise.reject(error); }
    this.pending++;
    const run = this.tail.then(async () => {
      this.assertWritable();
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          work(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(failure()); }, this.timeoutMs);
          }),
        ]);
      } catch {
        this.fault = failure();
        throw this.fault;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }).finally(() => { this.pending--; });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertSignal(signal: AbortSignal): void {
    if (signal.aborted || this.fault) throw failure();
  }

  private async context(identity: VmWorkspaceIdentity | null, signal: AbortSignal): Promise<StreamContext> {
    const family = identity ? 'memory' : 'body';
    const key = identity ? `memory:${identity.agentId}/${identity.workspaceId}` : 'body';
    const existing = this.bindings.get(key);
    const policy = await this.persistence!.selectStream(family, identity, signal);
    this.assertSignal(signal);
    if (rappChainTrustAuthority(policy) !== ACCEPTED_RAPP_PROTOCOL_AUTHORITY || !policy.persistedHead) {
      throw failure();
    }
    const stream = policy.trustedGenesis.streamId;
    if (existing && existing !== stream) throw failure();
    let context = this.contexts.get(stream);
    if (context) {
      if (context.family !== family
        || context.policy.trustedGenesis.frameHash !== policy.trustedGenesis.frameHash
        || context.policy.trustedGenesis.payloadHash !== policy.trustedGenesis.payloadHash
        || policy.persistedHead.seq < context.policy.persistedHead!.seq) throw failure();
      context.policy = policy;
    } else {
      context = { policy, knownPolicy: policy, family, frames: [], trust: null };
      this.contexts.set(stream, context);
    }
    this.bindings.set(key, stream);
    return context;
  }

  private async scan(context: StreamContext, signal: AbortSignal): Promise<readonly RappFrame[]> {
    const stream = context.policy.trustedGenesis.streamId;
    const sources = await this.persistence!.readStream(stream, signal);
    this.assertSignal(signal);
    if (!Array.isArray(sources) || !sources.length) throw failure();
    const profile = context.family === 'body' ? RAPP_ACCEPTED_BODY_STREAM_PROFILE : RAPP_ACCEPTED_MEMORY_STREAM_PROFILE;
    const frames: RappFrame[] = [];
    let head: RappFrame | null = null;
    for (const source of sources) {
      if (typeof source !== 'string') throw failure();
      const scanned: RappFrameVerification<RappFrame> = verifyRappFrameJson(source, profile, { head, streamIdOfRecord: stream });
      if (!scanned.ok || frameBytes(scanned.frame) !== source) throw failure();
      const frame: RappFrame = scanned.frame;
      if (frame.payload.component === COMPONENT) this.verifyApplicationFrame(frame);
      frames.push(frame);
      head = frame;
    }
    const checked = verifyRappFrameChain(frames, profile, context.policy);
    if (!checked.ok) throw failure();
    // A newer host checkpoint cannot erase a prefix this consumer already
    // verified, even if a divergent candidate also has a valid genesis/hash.
    if (!verifyRappFrameChain(frames, profile, context.knownPolicy).ok) throw failure();
    this.assertSignal(signal);
    context.frames = checked.frames;
    context.trust = checked.trust;
    if (context.knownPolicy.persistedHead?.frameHash !== checked.head.frame_hash) {
      context.knownPolicy = selectRappChainTrustPolicy({
        authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
        trustedGenesis: context.policy.trustedGenesis,
        persistedHead: { streamId: stream, seq: checked.head.seq, frameHash: checked.head.frame_hash },
      });
    }
    return checked.frames;
  }

  private verifyApplicationFrame(frame: RappFrame): void {
    const payload = frame.payload;
    if (Object.keys(payload).sort().join(',') !== 'component,details,event_kind,protocol_revision,vm_name') throw failure();
    if (typeof payload.vm_name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(payload.vm_name)) throw failure();
    const event = payload.event_kind as VmEvent;
    if (!(BODY_EVENTS.has(event) && frame.kind === 'body.pulse')
      && !(TOOL_EVENTS.has(event) && frame.kind === 'memory.tool-call')) throw failure();
    const authority = protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
    if (!payload.details || Array.isArray(payload.details) || typeof payload.details !== 'object'
      || !payload.protocol_revision || Array.isArray(payload.protocol_revision) || typeof payload.protocol_revision !== 'object'
      || Object.keys(payload.protocol_revision).length !== 3
      || payload.protocol_revision.revision !== authority.revision
      || payload.protocol_revision.frame_hash !== authority.frame_hash
      || payload.protocol_revision.payload_hash !== authority.payload_hash) throw failure();
  }

  prepare(identity: VmWorkspaceIdentity | null = null): Promise<void> {
    return this.enqueue(async (signal) => {
      const context = await this.context(identity, signal);
      await this.scan(context, signal);
    });
  }

  record(
    vmName: string,
    event: VmEvent,
    details: JsonObject,
    identity: VmWorkspaceIdentity | null = null,
  ): Promise<RappFrame> {
    return this.enqueue(async (signal) => {
      if (TOOL_EVENTS.has(event) !== (identity !== null)) throw failure();
      const context = await this.context(identity, signal);
      const history = await this.scan(context, signal);
      const head = history[history.length - 1];
      const kind = identity ? 'memory.tool-call' : 'body.pulse';
      const profile = identity ? MEMORY_TOOL_PROFILE : RAPP_ACCEPTED_BODY_PULSE_PROFILE;
      const frame = buildRappFrame({
        kind, streamId: head.stream_id, head,
        utc: new Date(Math.max(this.now(), Date.parse(head.utc) + 1)).toISOString(),
        payload: {
          component: COMPONENT, event_kind: event, vm_name: vmName, details,
          protocol_revision: { ...protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY) },
        },
      }, profile);
      this.verifyApplicationFrame(frame);
      this.assertSignal(signal);
      await this.persistence!.appendFrame(frameBytes(frame), frameHead(head), signal);
      this.assertSignal(signal);
      await this.context(identity, signal);
      if (context.policy.persistedHead!.seq < frame.seq) throw failure();
      const committed = await this.scan(context, signal);
      const receipt = committed.find((candidate) => candidate.seq === frame.seq);
      if (!receipt || receipt.frame_hash !== frame.frame_hash || frameBytes(receipt) !== frameBytes(frame)) throw failure();
      return receipt;
    });
  }
}
