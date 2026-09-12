import {
  AUTHORITY_IDENTITY, assertOptions, canonicalJson, isJsonObject, isUtc, isVerifiedChain, verifyEvidenceLink,
  type JsonObject, type RappFrame, type VerifiedChain,
} from '@rapp-work/rapp1';
import { AuthorizationError, type OperationRequest, operationHash, resourceList } from './contracts.js';

export interface ApprovalState {
  readonly id: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly operationHash: string;
  readonly resources: readonly string[];
  readonly expiresUtc: string;
  readonly decision: 'pending' | 'approved' | 'denied';
  readonly consumedBy: string | null;
}

/** No cached boolean, caller-supplied approval object or foreign stream is authorization. */
export function approvalFromFrames(memory: VerifiedChain, body: VerifiedChain, approvalId: string): ApprovalState {
  if (!isVerifiedChain(memory) || !isVerifiedChain(body) || memory.trust.persistedHead !== 'matched' || body.trust.persistedHead !== 'matched') {
    throw new AuthorizationError('untrusted-approval', 'Approval requires a scanned committed chain');
  }
  let approval: ApprovalState | null = null;
  for (const frame of memory.frames) {
    const payload = frame.payload;
    if (!isJsonObject(payload.data as never)) continue;
    const data = payload.data as JsonObject;
    if (data.approval_id !== approvalId) continue;
    if (!['approval.requested', 'approval.decided', 'intent.permitted'].includes(data.type as string)) continue;
    const evidence = body.frames.filter((candidate) => {
      const references = candidate.payload.reference_hashes;
      return candidate.payload.event_kind === data.type && Array.isArray(references) && references.includes(frame.frame_hash);
    });
    if (evidence.length !== 1) throw new AuthorizationError('approval-evidence', 'Approval transition needs exactly one occurrence-bound evidence frame');
    verifyEvidenceLink({
      body, source: memory, sourceFrameHash: frame.frame_hash, evidenceFrameHash: evidence[0]!.frame_hash,
      subject: payload.subject as string, eventKind: data.type as string, data,
    });
    if (canonicalJson(payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
      throw new AuthorizationError('approval-authority', 'Approval has a different authority');
    }
    if (data.type === 'approval.requested') {
      assertOptions(data, [
        'type', 'agent_id', 'workspace_id', 'task_id', 'approval_id', 'principal_id',
        'operation_hash', 'resources', 'expires_utc',
      ]);
      if (approval || frame.kind !== 'memory.save' || !isUtc(data.expires_utc)
        || typeof data.principal_id !== 'string' || typeof data.agent_id !== 'string'
        || typeof data.workspace_id !== 'string' || typeof data.task_id !== 'string'
        || typeof data.operation_hash !== 'string' || !/^[0-9a-f]{64}$/.test(data.operation_hash)) {
        throw new AuthorizationError('approval-transition', 'Invalid or repeated approval request');
      }
      approval = Object.freeze({
        id: approvalId, principalId: data.principal_id, agentId: data.agent_id, workspaceId: data.workspace_id,
        taskId: data.task_id, operationHash: data.operation_hash, resources: resourceList(data.resources),
        expiresUtc: data.expires_utc, decision: 'pending', consumedBy: null,
      });
    } else if (data.type === 'approval.decided') {
      assertOptions(data, ['type', 'agent_id', 'workspace_id', 'task_id', 'approval_id', 'decision', 'decided_by']);
      if (!approval || approval.decision !== 'pending' || approval.consumedBy !== null
        || frame.kind !== 'memory.tool-call' || frame.utc >= approval.expiresUtc
        || !['approved', 'denied'].includes(data.decision as string) || typeof data.decided_by !== 'string') {
        throw new AuthorizationError('approval-transition', 'Invalid approval decision');
      }
      assertScope(data, approval);
      approval = Object.freeze({ ...(approval as ApprovalState), decision: data.decision as 'approved' | 'denied' });
    } else {
      assertOptions(data, [
        'type', 'agent_id', 'workspace_id', 'task_id', 'run_id', 'intent_id', 'intent_frame_hash',
        'permit_id', 'operation_hash', 'approval_id', 'principal_id', 'expires_utc',
      ]);
      if (!approval || approval.decision !== 'approved' || approval.consumedBy !== null
        || frame.kind !== 'memory.tool-call' || frame.utc >= approval.expiresUtc
        || data.operation_hash !== approval.operationHash || data.principal_id !== approval.principalId
        || typeof data.permit_id !== 'string' || !isUtc(data.expires_utc) || data.expires_utc > approval.expiresUtc) {
        throw new AuthorizationError('approval-reused', 'Approval was already used or has no matching grant');
      }
      assertScope(data, approval);
      approval = Object.freeze({ ...(approval as ApprovalState), consumedBy: data.permit_id });
    }
  }
  if (!approval) throw new AuthorizationError('approval-missing', 'No canonical approval request');
  return approval;
}

function assertScope(data: JsonObject, approval: ApprovalState): void {
  if (data.agent_id !== approval.agentId || data.workspace_id !== approval.workspaceId
    || data.task_id !== approval.taskId) throw new AuthorizationError('approval-scope', 'Cross-owner approval event');
}

export function assertApprovalForOperation(approval: ApprovalState, request: OperationRequest, now: number): void {
  if (approval.decision !== 'approved' || approval.consumedBy !== null || now >= Date.parse(approval.expiresUtc)
    || approval.agentId !== request.agent_id || approval.workspaceId !== request.workspace_id
    || approval.taskId !== request.task_id || approval.principalId !== request.principal_id
    || approval.operationHash !== operationHash(request) || canonicalJson(approval.resources) !== canonicalJson(request.resources)) {
    throw new AuthorizationError('approval-binding', 'Approval does not authorize this exact unexpired single use');
  }
}

export function frameData(frame: RappFrame): JsonObject {
  assertOptions(frame.payload, ['subject', 'data', 'protocol_revision']);
  if (typeof frame.payload.subject !== 'string' || !isJsonObject(frame.payload.data!)
    || canonicalJson(frame.payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new AuthorizationError('payload', 'Invalid canonical work payload');
  }
  return frame.payload.data;
}
