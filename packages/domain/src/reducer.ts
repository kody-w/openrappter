import {
  EVIDENCE_SCHEMA, assertOptions, canonicalJson, hashValue, isVerifiedChain, PARTICLE_DOMAIN, snapshotJson,
  validateEvidencePayload, type EvidencePayload, type FrameHead, type JsonObject, type RappFrame, type VerifiedChain,
} from '@rapp-work/rapp1';
import { assertIdentifier, operationHash, type OperationRequest } from '@rapp-work/security';
import {
  DomainError, eventFrameKind, validateDomainPayload, type Cadence, type DomainEvent, type TaskTemplate, type ToolPolicy,
} from './events.js';
import { computerObservationFrame, reduceComputerHistory, type ComputerProjection } from './computer.js';

export interface Provenance { sourceFrameHash: string; evidenceFrameHash: string; utc: string }
export interface AgentProjection extends Provenance {
  id: string; workspaceId: string; name: string; instructions: string; provider: 'github-copilot';
  toolPolicy: ToolPolicy; status: 'active' | 'paused' | 'retired';
}
export type TaskStatus = 'queued' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
export interface TaskProjection extends Provenance {
  id: string; title: string; instructions: string; maxAttempts: number; attempts: number;
  status: TaskStatus; activeRunId: string | null; reason: string | null; runIds: string[]; scheduledBy: string | null;
}
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unresolved';
export interface RunProjection extends Provenance {
  id: string; taskId: string; attempt: number; status: RunStatus; cancelRequested: boolean; error: string | null;
  checkpoints: JsonObject[]; intentIds: string[]; startedFrameHash: string;
}
export interface ScheduleProjection extends Provenance {
  id: string; name: string; taskTemplate: TaskTemplate; cadence: Cadence; nextUtc: string;
  status: 'active' | 'paused' | 'retired'; firedTaskIds: string[];
}
export interface ApprovalProjection extends Provenance {
  id: string; taskId: string; principalId: string; operationHash: string; resources: string[]; expiresUtc: string;
  decision: 'pending' | 'approved' | 'denied'; decidedBy: string | null; consumedBy: string | null;
}
export interface MessageProjection extends Provenance {
  id: string; taskId: string | null; role: 'user' | 'assistant' | 'system'; content: string; referenceHashes: string[];
}
export interface MemoryProjection extends Provenance { id: string; taskId: string | null; content: string; sourceHashes: string[] }
export interface ArtifactProjection extends Provenance {
  id: string; taskId: string; runId: string | null; path: string; sha256: string; bytes: number;
  mediaType: string; status: 'available' | 'removed';
}
export interface IntentProjection extends Provenance {
  id: string; taskId: string; runId: string; request: OperationRequest; operationHash: string; approvalId: string | null;
  acceptedFrameHash: string; acceptedPayloadHash: string;
  status: 'accepted' | 'permitted' | 'success' | 'error' | 'cancelled' | 'unresolved';
  permitId: string | null; permittedFrameHash: string | null; permittedPayloadHash: string | null; expiresUtc: string | null;
}
export interface OutcomeProjection extends Provenance {
  intentId: string; runId: string; taskId: string; status: 'success' | 'error' | 'cancelled' | 'unresolved';
  result: JsonObject | null; error: string | null; previousOutcomeFrameHash: string | null;
}
export interface DomainProjection {
  agent: AgentProjection | null;
  tasks: Record<string, TaskProjection>;
  runs: Record<string, RunProjection>;
  schedules: Record<string, ScheduleProjection>;
  approvals: Record<string, ApprovalProjection>;
  messages: MessageProjection[];
  memories: Record<string, MemoryProjection>;
  artifacts: Record<string, ArtifactProjection>;
  intents: Record<string, IntentProjection>;
  outcomes: Record<string, OutcomeProjection>;
  computer: ComputerProjection | null;
  computerReferences: { runId: string; taskId: string; frameHash: string; state: string }[];
  unresolvedIntentIds: string[];
  heads: { body: FrameHead | null; memory: FrameHead | null; computer: FrameHead | null };
}
export interface ProjectionInput {
  agentId: string;
  workspaceId: string;
  body: VerifiedChain | null;
  memory: VerifiedChain | null;
  computer?: VerifiedChain;
}

function fail(code: string, message: string): never { throw new DomainError(code, message); }
function get<T>(map: Record<string, T>, id: string, name: string): T {
  const value = map[id];
  if (!value) fail('missing-reference', `Missing ${name}`);
  return value;
}
function unique<T>(map: Record<string, T>, id: string): void {
  if (Object.hasOwn(map, id)) fail('duplicate-id', 'Durable IDs cannot be reused');
}
function update<T extends Provenance>(item: T, proof: Provenance): void { Object.assign(item, proof); }
function committed(chain: VerifiedChain): void {
  if (!isVerifiedChain(chain) || chain.trust.persistedHead !== 'matched') fail('untrusted-chain', 'Only scanned committed chains are projection authority');
}
function dict<T>(): Record<string, T> { return Object.create(null) as Record<string, T>; }

/** A fresh pure fold. No filesystem, database, provider, clock, mutable cache or supplied state. */
export function reduceWorkspace(input: ProjectionInput): Readonly<DomainProjection> {
  assertOptions(input, ['agentId', 'workspaceId', 'body', 'memory', 'computer'], ['agentId', 'workspaceId', 'body', 'memory']);
  assertIdentifier(input.agentId, 'agent'); assertIdentifier(input.workspaceId, 'workspace');
  const state: DomainProjection = {
    agent: null, tasks: dict(), runs: dict(), schedules: dict(), approvals: dict(), messages: [],
    memories: dict(), artifacts: dict(), intents: dict(), outcomes: dict(), computer: null, computerReferences: [],
    unresolvedIntentIds: [], heads: { body: null, memory: null, computer: null },
  };
  if (input.computer !== undefined) {
    state.computer = reduceComputerHistory(input.computer);
    state.heads.computer = input.computer.head;
  }
  if (input.body === null && input.memory === null) return snapshotJson(state) as unknown as Readonly<DomainProjection>;
  if (input.body === null || input.memory === null) fail('incomplete-history', 'Both source and evidence histories are required');
  const body = input.body, memory = input.memory;
  committed(body); committed(memory);
  if (memory.head.stream_id !== `${body.head.stream_id}:work`) fail('producer', 'Domain streams must belong to one workspace producer');
  state.heads.body = body.head; state.heads.memory = memory.head;
  const evidenceByReference = new Map<string, { frame: RappFrame; payload: EvidencePayload }[]>();
  const evidenceParticles = new Set<string>();
  for (const frame of body.frames) {
    if (frame.payload.schema !== EVIDENCE_SCHEMA) continue;
    if (frame.kind !== 'body.pulse') fail('evidence-kind', 'Wrong evidence frame kind');
    const payload = validateEvidencePayload(frame.payload);
    if (evidenceParticles.has(frame.payload_hash)) fail('evidence-replay', 'Repeated evidence particle');
    evidenceParticles.add(frame.payload_hash);
    for (const reference of payload.reference_hashes) {
      const values = evidenceByReference.get(reference) ?? [];
      values.push({ frame, payload }); evidenceByReference.set(reference, values);
    }
  }
  const operations = new Set<string>(), operationIds = new Set<string>(), permitIds = new Set<string>(), messageIds = new Set<string>();
  for (const frame of memory.frames) {
    const payload = validateDomainPayload(frame.payload);
    const event = payload.data;
    if (event.agent_id !== input.agentId || event.workspace_id !== input.workspaceId) fail('ownership', 'Cross-agent/workspace event');
    if (frame.kind !== eventFrameKind(event.type)) fail('event-kind', 'Application event used the wrong registered kind');
    const candidates = (evidenceByReference.get(frame.frame_hash) ?? []).filter((entry) =>
      entry.payload.reference_hashes.includes(frame.payload_hash)
      && entry.payload.event_kind === event.type && entry.payload.subject === payload.subject
      && entry.payload.data_hash === hashValue(PARTICLE_DOMAIN, event) && entry.frame.utc >= frame.utc);
    if (candidates.length !== 1) fail('evidence-binding', 'Every transition needs one exact committed source/evidence pair');
    const evidence = candidates[0]!;
    const proof: Provenance = { sourceFrameHash: frame.frame_hash, evidenceFrameHash: evidence.frame.frame_hash, utc: frame.utc };
    const requireReferences = (...references: string[]): void => {
      for (const reference of references) {
        if (!evidence.payload.reference_hashes.includes(reference)) fail('evidence-reference', 'Required operation/intent/receipt reference is absent');
      }
    };
    if (event.type !== 'agent.created' && state.agent === null) fail('agent-missing', 'Agent creation must precede its work');
    const task = (id: string): TaskProjection => get(state.tasks, id, 'task');
    const run = (taskId: string, runId: string): RunProjection => {
      const value = get(state.runs, runId, 'run');
      if (value.taskId !== taskId) fail('run-ownership', 'Run belongs to another task');
      return value;
    };
    const active = (value: RunProjection): void => {
      if (value.status !== 'running') fail('run-terminal', 'Terminal or unresolved run cannot execute again');
    };
    const enabled = (): void => { if (state.agent?.status !== 'active') fail('agent-disabled', 'Agent is not enabled for execution'); };
    const notRetired = (): void => { if (state.agent?.status === 'retired') fail('agent-retired', 'Retired agent cannot accept new work'); };
    const intent = (event: DomainEvent): IntentProjection => {
      const value = get(state.intents, event.intent_id as string, 'intent');
      if (value.taskId !== event.task_id || value.runId !== event.run_id) fail('intent-ownership', 'Intent belongs to another task/run');
      return value;
    };
    switch (event.type) {
      case 'agent.created':
        if (state.agent !== null) fail('agent-duplicate', 'Agent can only be created once');
        state.agent = {
          ...proof, id: input.agentId, workspaceId: input.workspaceId, name: event.name, instructions: event.instructions,
          provider: event.provider, toolPolicy: event.tool_policy, status: 'active',
        };
        break;
      case 'agent.configured':
        notRetired();
        if (Object.values(state.runs).some((value) => value.status === 'running' || value.status === 'unresolved')) fail('agent-busy', 'Cannot replace policy during a run');
        Object.assign(state.agent!, { name: event.name, instructions: event.instructions, provider: event.provider, toolPolicy: event.tool_policy }, proof);
        break;
      case 'agent.paused':
        if (state.agent!.status !== 'active') fail('agent-transition', 'Only an active agent can pause');
        state.agent!.status = 'paused'; update(state.agent!, proof); break;
      case 'agent.resumed':
        if (state.agent!.status !== 'paused') fail('agent-transition', 'Only a paused agent can resume');
        state.agent!.status = 'active'; update(state.agent!, proof); break;
      case 'agent.retired':
        notRetired();
        if (Object.values(state.runs).some((value) => value.status === 'running' || value.status === 'unresolved')) fail('agent-busy', 'Resolve all runs before retirement');
        state.agent!.status = 'retired'; update(state.agent!, proof); break;
      case 'task.created':
        notRetired(); unique(state.tasks, event.task_id);
        state.tasks[event.task_id] = {
          ...proof, id: event.task_id, title: event.title, instructions: event.instructions,
          maxAttempts: event.max_attempts, attempts: 0, status: 'queued', activeRunId: null, reason: null, runIds: [], scheduledBy: null,
        }; break;
      case 'task.updated': {
        const value = task(event.task_id);
        if (value.activeRunId !== null || !['queued', 'blocked'].includes(value.status)) fail('task-transition', 'Cannot edit active or terminal work');
        Object.assign(value, { title: event.title, instructions: event.instructions }, proof); break;
      }
      case 'task.status-changed': {
        const value = task(event.task_id);
        if (value.activeRunId !== null || !['queued', 'blocked'].includes(value.status) || event.status === value.status) fail('task-transition', 'Invalid task transition');
        Object.assign(value, { status: event.status, reason: event.reason }, proof); break;
      }
      case 'task.retried': {
        enabled();
        const value = task(event.task_id);
        if (!['failed', 'cancelled'].includes(value.status) || value.activeRunId !== null || value.attempts >= value.maxAttempts
          || Object.values(state.intents).some((item) => item.taskId === value.id && ['accepted', 'permitted', 'unresolved'].includes(item.status))) {
          fail('retry', 'Only an explicit bounded retry of settled work is allowed');
        }
        Object.assign(value, { status: 'queued', reason: event.reason }, proof); break;
      }
      case 'schedule.created':
        notRetired(); unique(state.schedules, event.schedule_id);
        if (event.next_utc < frame.utc) fail('schedule-time', 'Initial schedule is already in the past');
        state.schedules[event.schedule_id] = {
          ...proof, id: event.schedule_id, name: event.name, taskTemplate: event.task_template, cadence: event.cadence,
          nextUtc: event.next_utc, status: 'active', firedTaskIds: [],
        }; break;
      case 'schedule.updated': {
        notRetired();
        const value = get(state.schedules, event.schedule_id, 'schedule');
        if (value.status === 'retired' || event.next_utc < frame.utc) fail('schedule-transition', 'Cannot update retired or past schedule');
        Object.assign(value, { name: event.name, taskTemplate: event.task_template, cadence: event.cadence, nextUtc: event.next_utc }, proof); break;
      }
      case 'schedule.paused': case 'schedule.resumed': case 'schedule.retired': {
        const value = get(state.schedules, event.schedule_id, 'schedule');
        const status = event.type === 'schedule.paused' ? 'paused' : event.type === 'schedule.resumed' ? 'active' : 'retired';
        if (value.status === 'retired' || value.status === status) fail('schedule-transition', 'Invalid schedule lifecycle');
        if (status === 'active') notRetired();
        value.status = status; update(value, proof); break;
      }
      case 'schedule.fired': {
        enabled();
        const value = get(state.schedules, event.schedule_id, 'schedule');
        const created = task(event.task_id);
        if (value.status !== 'active' || event.scheduled_utc !== value.nextUtc || frame.utc < event.scheduled_utc
          || event.next_utc <= event.scheduled_utc || value.firedTaskIds.includes(event.task_id)
          || created.status !== 'queued' || created.scheduledBy !== null || created.title !== value.taskTemplate.title
          || created.instructions !== value.taskTemplate.instructions || created.maxAttempts !== value.taskTemplate.max_attempts) {
          fail('schedule-fire', 'Schedule firing is stale, early, duplicated or not bound to its task template');
        }
        if (value.cadence.kind === 'interval'
          && Date.parse(event.next_utc) - Date.parse(event.scheduled_utc) !== value.cadence.seconds * 1000) fail('schedule-cadence', 'Interval drift');
        value.firedTaskIds.push(event.task_id); value.nextUtc = event.next_utc;
        created.scheduledBy = value.id; update(created, proof); update(value, proof); break;
      }
      case 'run.started': {
        enabled(); unique(state.runs, event.run_id);
        const value = task(event.task_id);
        if (value.status !== 'queued' || value.activeRunId !== null || event.attempt !== value.attempts + 1 || event.attempt > value.maxAttempts) fail('run-start', 'Task is not ready for this bounded attempt');
        state.runs[event.run_id] = {
          ...proof, id: event.run_id, taskId: event.task_id, attempt: event.attempt, status: 'running',
          cancelRequested: false, error: null, checkpoints: [], intentIds: [], startedFrameHash: frame.frame_hash,
        };
        value.status = 'running'; value.activeRunId = event.run_id; value.attempts++; value.runIds.push(event.run_id); update(value, proof); break;
      }
      case 'run.checkpointed': {
        const value = run(event.task_id, event.run_id); active(value);
        if (event.checkpoint_index !== value.checkpoints.length || value.cancelRequested) fail('checkpoint-order', 'Checkpoint is not the next active step');
        value.checkpoints.push(event.checkpoint); update(value, proof); break;
      }
      case 'run.cancel-requested': {
        const value = run(event.task_id, event.run_id); active(value);
        if (value.cancelRequested) fail('cancel-replay', 'Cancellation was already requested');
        value.cancelRequested = true; update(value, proof); break;
      }
      case 'run.finished': case 'run.resolved': {
        const value = run(event.task_id, event.run_id);
        if (event.type === 'run.resolved') {
          if (value.status !== 'unresolved') fail('run-resolution', 'Only unresolved runs can be reconciled');
        } else active(value);
        const unsettled = value.intentIds.some((id) => ['accepted', 'permitted', 'unresolved'].includes(state.intents[id]!.status));
        if ((unsettled && event.status !== 'unresolved') || (event.status === 'succeeded'
          && (value.cancelRequested || value.intentIds.some((id) => state.intents[id]!.status !== 'success')))
          || (event.status === 'cancelled' && !value.cancelRequested)) fail('run-outcome', 'Run cannot claim a resolved outcome for unresolved or cancelled effects');
        value.status = event.status; value.error = event.error; update(value, proof);
        const parent = task(event.task_id);
        parent.status = event.status === 'unresolved' ? 'blocked' : event.status;
        parent.activeRunId = event.status === 'unresolved' ? value.id : null; parent.reason = event.error; update(parent, proof); break;
      }
      case 'approval.requested':
        task(event.task_id); unique(state.approvals, event.approval_id);
        if (event.expires_utc <= frame.utc) fail('approval-expiry', 'Approval is already expired');
        state.approvals[event.approval_id] = {
          ...proof, id: event.approval_id, taskId: event.task_id, principalId: event.principal_id,
          operationHash: event.operation_hash, resources: event.resources, expiresUtc: event.expires_utc,
          decision: 'pending', decidedBy: null, consumedBy: null,
        }; break;
      case 'approval.decided': {
        const value = get(state.approvals, event.approval_id, 'approval');
        if (value.taskId !== event.task_id || value.decision !== 'pending' || frame.utc >= value.expiresUtc) fail('approval-decision', 'Decision is stale, expired or foreign');
        value.decision = event.decision; value.decidedBy = event.decided_by; update(value, proof); break;
      }
      case 'message.recorded':
        if (event.task_id !== null) task(event.task_id);
        if (messageIds.has(event.message_id)) fail('message-replay', 'Message ID was already committed');
        messageIds.add(event.message_id);
        state.messages.push({ ...proof, id: event.message_id, taskId: event.task_id, role: event.role, content: event.content, referenceHashes: event.reference_hashes }); break;
      case 'memory.recorded':
        if (event.task_id !== null) task(event.task_id);
        unique(state.memories, event.memory_id);
        state.memories[event.memory_id] = { ...proof, id: event.memory_id, taskId: event.task_id, content: event.content, sourceHashes: event.source_hashes }; break;
      case 'artifact.registered':
        task(event.task_id); unique(state.artifacts, event.artifact_id);
        if (event.run_id !== null) run(event.task_id, event.run_id);
        if (Object.values(state.artifacts).some((value) => value.path === event.path)) fail('artifact-path-reuse', 'Immutable artifact path was reused');
        state.artifacts[event.artifact_id] = {
          ...proof, id: event.artifact_id, taskId: event.task_id, runId: event.run_id, path: event.path,
          sha256: event.sha256, bytes: event.bytes, mediaType: event.media_type, status: 'available',
        }; break;
      case 'artifact.removed': {
        const value = get(state.artifacts, event.artifact_id, 'artifact');
        if (value.taskId !== event.task_id || value.status !== 'available') fail('artifact-removal', 'Artifact is already removed or foreign');
        value.status = 'removed'; update(value, proof); break;
      }
      case 'computer.referenced': {
        run(event.task_id, event.run_id);
        if (input.computer === undefined) fail('computer-proof', 'No shared-computer body history was provided');
        const observed = input.computer.frames.find((value) => value.frame_hash === event.computer_frame_hash);
        if (!observed || observed.utc > frame.utc) fail('computer-proof', 'Referenced computer receipt is missing or in the future');
        const observation = computerObservationFrame(observed);
        requireReferences(observed.frame_hash, observed.payload_hash);
        state.computerReferences.push({ runId: event.run_id, taskId: event.task_id, frameHash: observed.frame_hash, state: observation.state }); break;
      }
      case 'intent.accepted': {
        enabled();
        const parent = run(event.task_id, event.run_id); active(parent); unique(state.intents, event.intent_id);
        const request = event.request, digest = operationHash(request);
        if (parent.cancelRequested || request.agent_id !== input.agentId || request.workspace_id !== input.workspaceId
          || request.task_id !== event.task_id || request.run_id !== event.run_id || request.expires_utc <= frame.utc
          || operations.has(digest) || operationIds.has(request.operation_id)
          || !state.agent!.toolPolicy.operations.includes(request.operation)
          || (state.agent!.toolPolicy.approval_required.includes(request.operation) && event.approval_id === null)) {
          fail('intent-binding', 'Intent is duplicated, expired, disabled or belongs to another operation');
        }
        if (event.approval_id !== null) {
          const approval = get(state.approvals, event.approval_id, 'approval');
          if (approval.taskId !== event.task_id || approval.operationHash !== digest || approval.principalId !== request.principal_id
            || canonicalJson(approval.resources) !== canonicalJson(request.resources)) fail('approval-binding', 'Approval covers a different operation');
        }
        requireReferences(digest);
        operations.add(digest); operationIds.add(request.operation_id); parent.intentIds.push(event.intent_id);
        state.intents[event.intent_id] = {
          ...proof, id: event.intent_id, taskId: event.task_id, runId: event.run_id, request, operationHash: digest, approvalId: event.approval_id,
          acceptedFrameHash: frame.frame_hash, acceptedPayloadHash: frame.payload_hash, status: 'accepted',
          permitId: null, permittedFrameHash: null, permittedPayloadHash: null, expiresUtc: null,
        }; break;
      }
      case 'intent.permitted': {
        enabled(); const parent = run(event.task_id, event.run_id); active(parent);
        const value = intent(event);
        if (parent.cancelRequested || value.status !== 'accepted' || event.intent_frame_hash !== value.acceptedFrameHash
          || event.operation_hash !== value.operationHash || event.principal_id !== value.request.principal_id
          || event.approval_id !== value.approvalId || event.expires_utc <= frame.utc || event.expires_utc > value.request.expires_utc
          || permitIds.has(event.permit_id)) fail('permit-binding', 'Invalid or repeated single-use permit receipt');
        requireReferences(value.operationHash, value.acceptedFrameHash, value.acceptedPayloadHash);
        if (value.approvalId !== null) {
          const approval = get(state.approvals, value.approvalId, 'approval');
          if (approval.decision !== 'approved' || approval.consumedBy !== null || approval.expiresUtc <= frame.utc
            || event.expires_utc > approval.expiresUtc) fail('approval-consumption', 'Approval is not usable once at this time');
          approval.consumedBy = event.permit_id; update(approval, proof);
        }
        permitIds.add(event.permit_id);
        Object.assign(value, { status: 'permitted', permitId: event.permit_id, permittedFrameHash: frame.frame_hash,
          permittedPayloadHash: frame.payload_hash, expiresUtc: event.expires_utc }, proof); break;
      }
      case 'outcome.recorded': case 'outcome.resolved': {
        const value = intent(event);
        run(event.task_id, event.run_id);
        if (event.intent_frame_hash !== value.acceptedFrameHash || event.operation_hash !== value.operationHash || event.permit_id !== value.permitId) {
          fail('outcome-binding', 'Outcome references a different operation, permit or intent');
        }
        if (event.type === 'outcome.resolved') {
          const prior = get(state.outcomes, event.intent_id, 'unresolved outcome');
          if (value.status !== 'unresolved' || prior.status !== 'unresolved' || event.previous_outcome_frame_hash !== prior.sourceFrameHash) fail('outcome-resolution', 'Only the exact unresolved outcome can be reconciled');
          requireReferences(prior.sourceFrameHash);
        } else {
          unique(state.outcomes, event.intent_id);
          if (value.status !== 'permitted' && !(value.status === 'accepted' && event.status === 'cancelled' && event.permit_id === null)) {
            fail('outcome-without-permit', 'Effects require a prior canonical permit');
          }
        }
        requireReferences(value.operationHash, value.acceptedFrameHash, value.acceptedPayloadHash, ...event.reference_hashes);
        if (value.permittedFrameHash !== null) requireReferences(value.permittedFrameHash, value.permittedPayloadHash!);
        value.status = event.status; update(value, proof);
        state.outcomes[event.intent_id] = {
          ...proof, intentId: event.intent_id, runId: event.run_id, taskId: event.task_id, status: event.status,
          result: event.result, error: event.error, previousOutcomeFrameHash: event.type === 'outcome.resolved' ? event.previous_outcome_frame_hash : null,
        }; break;
      }
    }
  }
  for (const intent of Object.values(state.intents)) {
    if (!['permitted', 'unresolved'].includes(intent.status)) continue;
    state.unresolvedIntentIds.push(intent.id);
    const run = state.runs[intent.runId]!;
    // A spent permit without a terminal receipt is never reconstructed as replayable work.
    if (run.status === 'running') run.status = 'unresolved';
    const task = state.tasks[intent.taskId]!;
    if (task.activeRunId === run.id) task.status = 'blocked';
  }
  return snapshotJson(state) as unknown as Readonly<DomainProjection>;
}
