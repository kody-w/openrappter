import {
  buildRappFrame, createRappFrameProfile, selectRappChainTrustPolicy,
  type RappFrame,
} from '../../../../src/rapp/frame.js';
import { buildRappEvidenceFrame } from '../../../../src/rapp/evidence.js';
import { ACCEPTED_RAPP_PROTOCOL_AUTHORITY, protocolAuthorityIdentity } from '../../../../src/rapp/authority.js';
import { rappCanonicalJson, rappH, RAPP_PARTICLE_DOMAIN } from '../../../../src/rappids/canonical.js';
import {
  WORK_FRAME_BINDINGS, assertWorkClaim, workJsonObject, workCommitClaim,
  type WorkCommitRequest, type WorkCommitResponse, type WorkFrameProof, type WorkProjectionClaim,
} from '../../../../src/rapp/work-contract.js';
import {
  assertWorkCommitPrecondition, scanWorkProjection, scanWorkCommit, type WorkFrameSelection,
} from '../../../../src/rapp/work-verification.js';
import type { JsonObject } from '../../../../src/rappids/types.js';

interface FixtureStream {
  body: RappFrame[];
  memory: RappFrame[];
  source: RappFrame;
  evidence: RappFrame;
  claim: WorkProjectionClaim;
}

// Test-only, in-memory canonical frames. No filesystem persistence or VM implementation.
export class WorkFrameFixture {
  private streams = new Map<string, FixtureStream>();
  private time = 0;

  private utc() { return new Date(Date.UTC(2026, 8, 11, 12, 0, this.time++)).toISOString(); }
  private revision() { return workJsonObject(protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY)); }

  private stream(claim: WorkProjectionClaim): FixtureStream {
    const found = this.streams.get(claim.subject);
    if (found) return found;
    const bodyId = `rappid:@example/work-fixture:${(this.streams.size + 1).toString(16).padStart(64, '0')}`;
    const memory = buildRappFrame({
      kind: 'memory.save', streamId: `${bodyId}:work`, utc: this.utc(),
      payload: { fixture: 'explicitly selected synthetic genesis' }, head: null,
    }, createRappFrameProfile({ name: 'work-fixture-genesis', kind: 'memory.save' }));
    const body = buildRappEvidenceFrame({
      streamId: bodyId, utc: this.utc(), eventKind: 'fixture.genesis',
      subject: `fixture:${this.streams.size + 1}`, dataHash: memory.payload_hash,
      referenceHashes: [memory.payload_hash], head: null,
    });
    const created: FixtureStream = { body: [body], memory: [memory], source: memory, evidence: body, claim };
    this.streams.set(claim.subject, created);
    return created;
  }

  proof(subject: string): WorkFrameProof {
    const stream = this.streams.get(subject);
    if (!stream) throw new Error('Fixture stream not found');
    return {
      body: stream.body.map((frame) => rappCanonicalJson(workJsonObject(frame))),
      memory: stream.memory.map((frame) => rappCanonicalJson(workJsonObject(frame))),
      source_frame_hash: stream.source.frame_hash,
      evidence_frame_hash: stream.evidence.frame_hash,
    };
  }

  selection(subject: string): WorkFrameSelection {
    const stream = this.streams.get(subject);
    if (!stream) throw new Error('Fixture stream not found');
    const policy = (frames: RappFrame[]) => selectRappChainTrustPolicy({
      trustedGenesis: {
        streamId: frames[0].stream_id, frameHash: frames[0].frame_hash, payloadHash: frames[0].payload_hash,
      },
      persistedHead: {
        streamId: frames.at(-1)!.stream_id, seq: frames.at(-1)!.seq, frameHash: frames.at(-1)!.frame_hash,
      },
    });
    return { subject, body: policy(stream.body), memory: policy(stream.memory) };
  }

  prove(claim: WorkProjectionClaim) {
    assertWorkClaim(claim);
    const stream = this.stream(claim);
    if (stream.source.seq === 0 || rappCanonicalJson(stream.claim.data) !== rappCanonicalJson(claim.data) || stream.claim.scope !== claim.scope) {
      const binding = WORK_FRAME_BINDINGS[claim.scope];
      const source = buildRappFrame({
        kind: binding.kinds[0], streamId: stream.memory[0].stream_id, utc: this.utc(),
        payload: { subject: claim.subject, data: claim.data, protocol_revision: this.revision() },
        head: stream.memory.at(-1)!,
      }, createRappFrameProfile({ name: `work-fixture-${claim.scope}`, kind: binding.kinds[0] }));
      const evidence = buildRappEvidenceFrame({
        streamId: stream.body[0].stream_id, utc: this.utc(), eventKind: binding.events[0],
        subject: claim.subject, dataHash: rappH(RAPP_PARTICLE_DOMAIN, claim.data),
        referenceHashes: [source.payload_hash, source.frame_hash].sort(), head: stream.body.at(-1)!,
      });
      stream.memory.push(source);
      stream.body.push(evidence);
      stream.source = source;
      stream.evidence = evidence;
      stream.claim = claim;
    }
    return scanWorkProjection(claim, this.proof(claim.subject), this.selection(claim.subject));
  }

  prepare(request: WorkCommitRequest): RappFrame {
    const stream = this.streams.get(request.subject);
    if (!stream) throw new Error('No fixture precondition');
    const current = scanWorkProjection(stream.claim, this.proof(request.subject), this.selection(request.subject));
    assertWorkCommitPrecondition(request, current);
    const intent = buildRappFrame({
      kind: 'memory.tool-call', streamId: stream.memory[0].stream_id, utc: this.utc(),
      payload: {
        subject: request.subject, data: { phase: 'accepted' },
        protocol_revision: this.revision(), request: workJsonObject(request),
      },
      head: stream.memory.at(-1)!,
    }, createRappFrameProfile({ name: 'work-fixture-intent', kind: 'memory.tool-call' }));
    stream.memory.push(intent);
    return intent;
  }

  complete(request: WorkCommitRequest, data: JsonObject, intent: RappFrame, error: string | null = null): WorkCommitResponse {
    const stream = this.streams.get(request.subject)!;
    const source = buildRappFrame({
      kind: 'memory.tool-call', streamId: stream.memory[0].stream_id, utc: this.utc(),
      payload: {
        subject: request.subject, data, protocol_revision: this.revision(),
        request: workJsonObject(request), outcome: error === null ? 'success' : 'error', error,
      },
      head: stream.memory.at(-1)!,
    }, createRappFrameProfile({ name: 'work-fixture-result', kind: 'memory.tool-call' }));
    const event = error
      ? request.method === 'vm.start' ? 'vm.start-failed' : request.method === 'vm.stop' ? 'vm.stop-failed' : 'approval.failed'
      : request.method === 'vm.start' ? 'vm.started' : request.method === 'vm.stop' ? 'vm.stopped' : 'approval.decided';
    const evidence = buildRappEvidenceFrame({
      streamId: stream.body[0].stream_id, utc: this.utc(), eventKind: event,
      subject: request.subject, dataHash: rappH(RAPP_PARTICLE_DOMAIN, data),
      referenceHashes: [
        source.payload_hash, source.frame_hash, intent.payload_hash, intent.frame_hash,
        rappH(RAPP_PARTICLE_DOMAIN, workJsonObject(request)),
      ].sort(),
      head: stream.body.at(-1)!,
    });
    stream.memory.push(source);
    stream.body.push(evidence);
    stream.source = source;
    stream.evidence = evidence;
    stream.claim = workCommitClaim(request, data);
    return scanWorkCommit(request, data, this.proof(request.subject), this.selection(request.subject));
  }

  data(subject: string) { return this.streams.get(subject)!.claim.data; }
}

export function framedGateway(handler: (method: string, params?: Record<string, unknown>) => unknown | Promise<unknown>) {
  const fixture = new WorkFrameFixture();
  const replies = new Map<string, Promise<WorkCommitResponse>>();
  return async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'work.rapp.verify') return fixture.prove(params as unknown as WorkProjectionClaim);
    if (method !== 'work.rapp.commit') return handler(method, params);
    const request = params as unknown as WorkCommitRequest;
    const requestHash = rappH(RAPP_PARTICLE_DOMAIN, workJsonObject(request));
    const replay = replies.get(requestHash);
    if (replay) return replay;
    const intent = fixture.prepare(request);
    const outcome = (async () => {
      let result: unknown;
      try {
        result = await handler(request.method, request.params);
      } catch (error) {
        return fixture.complete(request, fixture.data(request.subject), intent, error instanceof Error ? error.message : String(error));
      }
      const raw = workJsonObject(result);
      const data = request.method === 'exec.respond' ? raw : { id: 'omarchy', name: 'Omarchy', ...raw };
      return fixture.complete(request, data, intent);
    })();
    replies.set(requestHash, outcome);
    return outcome;
  };
}
