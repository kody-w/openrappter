import type { JsonObject } from '../rappids/types.js';
import { parseRappJson, rappCanonicalJson, rappH, RAPP_PARTICLE_DOMAIN } from '../rappids/canonical.js';
import {
  RAPP_ACCEPTED_BODY_STREAM_PROFILE, RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  verifyRappFrameJson, verifyRappFrameChain, rappChainTrustAuthority,
  type RappChainTrustPolicy, type RappFrame, type RappFrameProfile,
} from './frame.js';
import { ACCEPTED_RAPP_PROTOCOL_AUTHORITY } from './authority.js';
import {
  assertWorkClaim, assertWorkCommitRequest, assertWorkScanBindings, sameWorkValue, assertWorkActionState,
  workFrameBasis, workCommitClaim, workScanRequest, workJsonObject,
  type WorkCommitRequest, type WorkCommitResponse, type WorkFrameProof,
  type WorkProjectionClaim, type WorkRappScan, type WorkScannedChain,
} from './work-contract.js';

/** Supplied by the gateway's trusted frame store, never deserialized from RPC input. */
export interface WorkFrameSelection {
  subject: string;
  body: RappChainTrustPolicy;
  memory: RappChainTrustPolicy;
}

const scannedProjections = new WeakSet<WorkRappScan>();
const rememberScan = scannedProjections.add.bind(scannedProjections);
const hasScan = scannedProjections.has.bind(scannedProjections);

function scan(
  lines: readonly string[],
  profile: RappFrameProfile<JsonObject, string>,
  policy: RappChainTrustPolicy,
): WorkScannedChain {
  if (rappChainTrustAuthority(policy) !== ACCEPTED_RAPP_PROTOCOL_AUTHORITY || !policy.persistedHead) {
    throw new Error('Work requires the selected authority and a store-selected committed head.');
  }
  const frames: RappFrame[] = [];
  for (const line of lines) {
    if (typeof line !== 'string' || rappCanonicalJson(parseRappJson(line)) !== line) {
      throw new Error('Work proof requires exact canonical RAPP/1 frame bytes.');
    }
    const result = verifyRappFrameJson(line, profile, {
      head: frames.at(-1) ?? null, streamIdOfRecord: policy.trustedGenesis.streamId,
    });
    if (!result.ok) throw result.error;
    frames.push(result.frame);
  }
  const result = verifyRappFrameChain(frames, profile, policy);
  if (!result.ok) throw result.error;
  if (result.trust.persistedHead !== 'matched') throw new Error('Presented frames are not the store-selected committed head.');
  return Object.freeze(result);
}

/** Verification contract only: no filesystem access, append operation, or VM command. */
export function scanWorkProjection(
  claim: WorkProjectionClaim,
  proof: WorkFrameProof,
  selection: WorkFrameSelection,
  request?: WorkCommitRequest,
): WorkRappScan {
  assertWorkClaim(claim);
  if (selection.subject !== claim.subject) throw new Error('The trusted store selection belongs to a different Work subject.');
  if (Object.keys(proof).sort().join(',') !== 'body,evidence_frame_hash,memory,source_frame_hash') {
    throw new Error('Work proofs contain only canonical frame bytes and references.');
  }
  const result: WorkRappScan = {
    body: scan(proof.body, RAPP_ACCEPTED_BODY_STREAM_PROFILE, selection.body),
    memory: scan(proof.memory, RAPP_ACCEPTED_MEMORY_STREAM_PROFILE, selection.memory),
    source_frame_hash: proof.source_frame_hash,
    evidence_frame_hash: proof.evidence_frame_hash,
  };
  const command = workScanRequest(result, request);
  assertWorkScanBindings(claim, result, rappH(RAPP_PARTICLE_DOMAIN, claim.data), command,
    command ? rappH(RAPP_PARTICLE_DOMAIN, workJsonObject(command)) : undefined);
  Object.freeze(result);
  rememberScan(result);
  return result;
}

/** The persistence owner must perform this CAS check before executing an action. */
export function assertWorkCommitPrecondition(request: WorkCommitRequest, current: WorkRappScan): void {
  if (!hasScan(current)) throw new Error('Work preconditions require a real canonical scan, not a wire receipt.');
  assertWorkCommitRequest(request);
  if (!sameWorkValue(request.basis, workFrameBasis(current))) {
    throw new Error('RAPP/1 Work heads changed. Refresh before deciding; do not execute or retry automatically.');
  }
  const source = current.memory.frames.find((frame) => frame.frame_hash === current.source_frame_hash);
  if (source?.payload.subject !== request.subject) throw new Error('Work action targets a different subject.');
  assertWorkActionState(request, workJsonObject(source.payload.data));
}

export function scanWorkCommit(
  request: WorkCommitRequest,
  data: JsonObject,
  proof: WorkFrameProof,
  selection: WorkFrameSelection,
): WorkCommitResponse {
  return { data, scan: scanWorkProjection(workCommitClaim(request, data), proof, selection, request) };
}
