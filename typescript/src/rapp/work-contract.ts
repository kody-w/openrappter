import type { JsonObject, JsonValue } from '../rappids/types.js';
import type { RappFrame, RappFrameHead, RappFrameChainVerification } from './frame.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY, protocolAuthorityIdentity,
  type ProtocolAuthorityIdentity,
} from './authority.js';
import { evidencePayloadProblem, OPENRAPPTER_EVIDENCE_SCHEMA } from './evidence-schema.js';
import { rappCanonicalJson } from './json.js';

export const WORK_FRAME_BINDINGS = {
  agent: { kinds: ['memory.save'], events: ['agent.snapshot'] },
  workspace: { kinds: ['memory.save'], events: ['workspace.snapshot'] },
  vm: { kinds: ['memory.save', 'memory.tool-call'], events: ['vm.snapshot', 'vm.started', 'vm.stopped', 'vm.start-failed', 'vm.stop-failed'] },
  approval: { kinds: ['memory.save'], events: ['approval.pending'] },
  'approval-decision': { kinds: ['memory.tool-call'], events: ['approval.decided', 'approval.failed'] },
  message: { kinds: ['memory.chat-turn'], events: ['chat.recorded'] },
  evidence: { kinds: ['memory.save'], events: ['evidence.recorded'] },
  run: { kinds: ['memory.tool-call'], events: ['run.recorded'] },
  task: { kinds: ['memory.save'], events: ['task.changed'] },
} as const;
for (const binding of Object.values(WORK_FRAME_BINDINGS)) {
  Object.freeze(binding.kinds);
  Object.freeze(binding.events);
  Object.freeze(binding);
}
Object.freeze(WORK_FRAME_BINDINGS);

export type WorkFrameScope = keyof typeof WORK_FRAME_BINDINGS;

export function workSubject(scope: WorkFrameScope, ...ids: string[]): string {
  if (!ids.length || ids.some((id) => !id)) throw new Error('Work subjects require non-empty resource identifiers.');
  return `${scope === 'approval-decision' ? 'approval' : scope}:${ids.map(encodeURIComponent).join('/')}`;
}

/** RPC query only. The durable records are the referenced eleven-key RAPP/1 frames. */
export interface WorkProjectionClaim {
  scope: WorkFrameScope;
  subject: string;
  data: JsonObject;
}

export interface WorkFrameProof {
  memory: readonly string[];
  body: readonly string[];
  source_frame_hash: string;
  evidence_frame_hash: string;
}

export type WorkScannedChain = Extract<RappFrameChainVerification, { ok: true }>;

export interface WorkRappScan {
  memory: WorkScannedChain;
  body: WorkScannedChain;
  source_frame_hash: string;
  evidence_frame_hash: string;
}

export interface WorkFrameBasis {
  protocol_revision: Readonly<ProtocolAuthorityIdentity>;
  memory: RappFrameHead;
  body: RappFrameHead;
  source_frame_hash: string;
  evidence_frame_hash: string;
}

export interface WorkCommitRequest {
  method: 'vm.start' | 'vm.stop' | 'exec.respond';
  subject: string;
  params: JsonObject;
  basis: WorkFrameBasis;
}

export interface WorkCommitResponse {
  data: JsonObject;
  scan: WorkRappScan;
}

export function workJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RAPP/1 object required.');
  rappCanonicalJson(value as JsonObject);
  return value as JsonObject;
}

export function sameWorkValue(a: unknown, b: unknown): boolean {
  return rappCanonicalJson(a as JsonValue) === rappCanonicalJson(b as JsonValue);
}

export function assertWorkClaim(claim: WorkProjectionClaim): void {
  if (Object.keys(claim).sort().join(',') !== 'data,scope,subject') throw new Error('Unexpected Work projection query fields.');
  if (!Object.hasOwn(WORK_FRAME_BINDINGS, claim.scope)) throw new Error('Unknown Work frame scope.');
  const prefix = claim.scope === 'approval-decision' ? 'approval' : claim.scope;
  if (typeof claim.subject !== 'string' || !claim.subject.startsWith(`${prefix}:`) || claim.subject.length <= prefix.length + 1) {
    throw new Error('RAPP/1 subject does not match the projection scope.');
  }
  workJsonObject(claim.data);
}

export function workFrameHead(frame: RappFrame): RappFrameHead {
  return {
    stream_id: frame.stream_id, seq: frame.seq, utc: frame.utc,
    payload_hash: frame.payload_hash, frame_hash: frame.frame_hash,
  };
}

export function workFrameBasis(scan: WorkRappScan): WorkFrameBasis {
  return {
    protocol_revision: protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY),
    memory: workFrameHead(scan.memory.head), body: workFrameHead(scan.body.head),
    source_frame_hash: scan.source_frame_hash, evidence_frame_hash: scan.evidence_frame_hash,
  };
}

export function workCommitClaim(request: WorkCommitRequest, data: JsonObject): WorkProjectionClaim {
  return {
    scope: request.method === 'exec.respond' ? 'approval-decision' : 'vm',
    subject: request.subject, data,
  };
}

export function workScanRequest(scan: WorkRappScan, explicit?: WorkCommitRequest): WorkCommitRequest | undefined {
  const recorded = scan.memory.frames.find((frame) => frame.frame_hash === scan.source_frame_hash)?.payload.request;
  if (explicit) return explicit;
  if (recorded === undefined) return undefined;
  const request = workJsonObject(recorded) as unknown as WorkCommitRequest;
  assertWorkCommitRequest(request);
  return request;
}

export function assertWorkCommitRequest(request: WorkCommitRequest): void {
  if (Object.keys(request).sort().join(',') !== 'basis,method,params,subject') throw new Error('Unexpected canonical Work request fields.');
  if (!['vm.start', 'vm.stop', 'exec.respond'].includes(request.method)) throw new Error('Unsupported canonical Work action.');
  workJsonObject(request.params);
  if (Object.keys(request.basis).sort().join(',') !== 'body,evidence_frame_hash,memory,protocol_revision,source_frame_hash') {
    throw new Error('Invalid canonical Work predecessor references.');
  }
  if (request.method === 'exec.respond') {
    if (Object.keys(request.params).sort().join(',') !== 'approvalId,approved'
      || typeof request.params.approvalId !== 'string' || !request.params.approvalId
      || typeof request.params.approved !== 'boolean'
      || request.subject !== workSubject('approval', request.params.approvalId)) throw new Error('Invalid framed approval decision.');
  } else if (Object.keys(request.params).length || request.subject !== 'vm:omarchy') {
    throw new Error('Invalid framed Omarchy operation.');
  }
  if (!sameWorkValue(request.basis.protocol_revision, protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY))) {
    throw new Error('Work action names an unselected protocol authority.');
  }
}

export function assertWorkActionState(request: WorkCommitRequest, data: JsonObject, now = Date.now()): void {
  assertWorkCommitRequest(request);
  if (request.method === 'exec.respond') {
    if (data.id !== request.params.approvalId || data.status !== 'pending'
      || typeof data.command !== 'string' || !data.command
      || (data.expiresAt !== undefined && (typeof data.expiresAt !== 'number' || data.expiresAt <= now))) {
      throw new Error('RAPP/1 approval is not pending, has expired, or names a different request.');
    }
  } else if (data.id !== 'omarchy' || data.local !== true
    || data.state !== (request.method === 'vm.start' ? 'stopped' : 'running')) {
    throw new Error('RAPP/1 VM action requires the expected state of the local Omarchy computer.');
  }
}

/** Call only after both chains pass canonical scanning and committed-head checks. */
export function assertWorkScanBindings(
  claim: WorkProjectionClaim,
  scan: WorkRappScan,
  dataHash: string,
  request?: WorkCommitRequest,
  requestHash?: string,
): void {
  assertWorkClaim(claim);
  const source = scan.memory.frames.find((frame) => frame.frame_hash === scan.source_frame_hash);
  const evidence = scan.body.frames.find((frame) => frame.frame_hash === scan.evidence_frame_hash);
  if (!source || !evidence) throw new Error('RAPP/1 proof does not contain its referenced frames.');
  const evidenceParticles = new Set<string>();
  for (const candidate of scan.body.frames) {
    if (candidate.payload.schema !== OPENRAPPTER_EVIDENCE_SCHEMA) continue;
    if (evidenceParticles.has(candidate.payload_hash)) throw new Error('Duplicate RAPP/1 evidence particle violates the existing evidence profile.');
    evidenceParticles.add(candidate.payload_hash);
  }
  if (!scan.memory.head.stream_id.startsWith(`${scan.body.head.stream_id}:`)) throw new Error('RAPP/1 body and memory owners differ.');
  const binding = WORK_FRAME_BINDINGS[claim.scope];
  if (!(binding.kinds as readonly string[]).includes(source.kind)) throw new Error('Wrong RAPP/1 source kind for the Work projection.');
  if (!request && (claim.scope === 'approval-decision' || (claim.scope === 'vm' && source.kind === 'memory.tool-call'))) {
    throw new Error('A Work action requires a request-bound RAPP/1 receipt.');
  }
  const payload = source.payload;
  if (Object.keys(payload).sort().join(',') !== (request ? 'data,error,outcome,protocol_revision,request,subject'
    : 'data,protocol_revision,subject')) throw new Error('Invalid canonical Work source payload.');
  if (payload.subject !== claim.subject || !sameWorkValue(payload.data, claim.data)) throw new Error('RAPP/1 source does not bind the displayed data.');
  if (!sameWorkValue(payload.protocol_revision, protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY))) throw new Error('RAPP/1 source authority differs from the selected checkpoint.');
  if (evidence.kind !== 'body.pulse') throw new Error('Work evidence must be a canonical body.pulse.');
  const problem = evidencePayloadProblem(evidence.payload, ACCEPTED_RAPP_PROTOCOL_AUTHORITY);
  if (problem) throw new Error(problem);
  if (evidence.payload.subject !== claim.subject || evidence.payload.data_hash !== dataHash
    || !(binding.events as readonly string[]).includes(String(evidence.payload.event_kind))) {
    throw new Error('RAPP/1 evidence does not bind this projection and event.');
  }
  const references = evidence.payload.reference_hashes as string[];
  if (!references.includes(source.payload_hash) || !references.includes(source.frame_hash)) {
    throw new Error('RAPP/1 evidence does not reference the source particle and exact frame occurrence.');
  }
  if (scan.memory.frames.some((frame) => frame.seq > source.seq && frame.payload.subject === claim.subject)
    || scan.body.frames.some((frame) => frame.seq > evidence.seq && frame.payload.subject === claim.subject)) {
    throw new Error('RAPP/1 projection was superseded by a later frame.');
  }
  if (request) {
    assertWorkCommitRequest(request);
    if (payload.outcome !== 'success' && payload.outcome !== 'error') throw new Error('RAPP/1 action outcome is missing.');
    if (payload.outcome === 'error' ? typeof payload.error !== 'string' || !payload.error : payload.error !== null) {
      throw new Error('RAPP/1 action error does not match its outcome.');
    }
    const event = payload.outcome === 'error'
      ? request.method === 'vm.start' ? 'vm.start-failed' : request.method === 'vm.stop' ? 'vm.stop-failed' : 'approval.failed'
      : request.method === 'vm.start' ? 'vm.started' : request.method === 'vm.stop' ? 'vm.stopped' : 'approval.decided';
    if (source.kind !== 'memory.tool-call' || evidence.payload.event_kind !== event
      || !sameWorkValue(payload.request, request) || !requestHash || !references.includes(requestHash)) {
      throw new Error('RAPP/1 action receipt does not bind the exact request.');
    }
    for (const family of ['body', 'memory'] as const) {
      const basis = request.basis[family];
      const previous = scan[family].frames.find((frame) => frame.seq === basis.seq);
      if (!previous || !sameWorkValue(workFrameHead(previous), basis)) throw new Error('RAPP/1 action lost its selected predecessor.');
    }
    if (source.seq <= request.basis.memory.seq || evidence.seq <= request.basis.body.seq) {
      throw new Error('RAPP/1 action receipt is not an append after the selected heads.');
    }
    const intents = scan.memory.frames.filter((frame) => frame.seq > request.basis.memory.seq && frame.seq < source.seq
      && frame.kind === 'memory.tool-call' && frame.payload.subject === request.subject
      && sameWorkValue(frame.payload.request, request) && sameWorkValue(frame.payload.data, { phase: 'accepted' }));
    if (intents.length !== 1 || !references.includes(intents[0].payload_hash) || !references.includes(intents[0].frame_hash)) {
      throw new Error('RAPP/1 action lacks exactly one referenced write-ahead intent frame.');
    }
  }
}
