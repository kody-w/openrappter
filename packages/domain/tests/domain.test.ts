import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_IDENTITY, buildEvidenceFrame, buildFrame, canonicalJson, frameHead, hashValue, PARTICLE_DOMAIN,
  scanChain, selectChainTrust, type JsonObject, type RappFrame, type VerifiedChain,
} from '@rapp-work/rapp1';
import { operationHash, type OperationRequest } from '@rapp-work/security';
import {
  buildComputerPayload, buildDomainPayload, EVENT_FIELDS, eventFrameKind, reduceComputerHistory, reduceWorkspace,
  validateCadence, validateComputerObservation, validateDomainPayload, validateEvent,
  type ComputerObservation, type DomainEvent, type EventType,
} from '../src/index.js';

const NOW = Date.parse('2026-09-11T12:00:00.000Z'), UTC = new Date(NOW).toISOString();
const BODY = `rappid:@alice/worker:${'a'.repeat(64)}`, MEMORY = `${BODY}:work`;
const COMPUTER = `rappid:@host/omarchy:${'b'.repeat(64)}`;
const scope = { agent_id: 'agent-a', workspace_id: 'workspace-a' };
const policy = { operations: ['guest.files.write'], approval_required: [] };
const template = { title: 'Prepare report', instructions: 'Prepare the monthly report', max_attempts: 2 };
const request: OperationRequest = {
  schema: 'rapp-work/operation/1', operation_id: 'operation-a', principal_id: 'alice', ...scope,
  task_id: 'task-a', run_id: 'run-a', operation: 'guest.files.write',
  resources: ['computer:omarchy', 'guest-path:reports/output.txt'], params: { path: 'reports/output.txt', text: 'Report' },
  expires_utc: new Date(NOW + 60_000).toISOString(),
};
function scan(frames: RappFrame[], persisted = frames.at(-1)!): VerifiedChain {
  const first = frames[0]!;
  const result = scanChain(frames.map(canonicalJson), selectChainTrust({
    genesis: { stream_id: first.stream_id, payload_hash: first.payload_hash, frame_hash: first.frame_hash },
    persistedHead: frameHead(persisted),
  }));
  if (!result.ok) throw result.error;
  return result;
}
class History {
  body: RappFrame[] = [];
  memory: RappFrame[] = [];
  computer: RappFrame[] = [];
  utc = UTC;
  add(event: JsonObject, options: { extra?: string[]; evidence?: boolean; kind?: string; payloadPatch?: JsonObject } = {}): RappFrame {
    const data = { ...scope, ...event } as DomainEvent;
    const payload = { ...buildDomainPayload(data), ...options.payloadPatch };
    const source = buildFrame({
      kind: options.kind ?? eventFrameKind(data.type), streamId: MEMORY, utc: this.utc,
      head: this.memory.length ? frameHead(this.memory.at(-1)!) : null, payload,
    });
    this.memory.push(source);
    if (options.evidence === false) return source;
    const extra: string[] = [...(options.extra ?? [])];
    if (data.type === 'intent.accepted') extra.push(operationHash(data.request));
    if (data.type === 'intent.permitted' || data.type === 'outcome.recorded' || data.type === 'outcome.resolved') {
      const accepted = this.memory.find((frame) => frame.frame_hash === data.intent_frame_hash);
      extra.push(data.operation_hash, data.intent_frame_hash);
      if (accepted) extra.push(accepted.payload_hash);
      if (data.type.startsWith('outcome.')) {
        const permitted = this.memory.find((frame) => (frame.payload.data as JsonObject).type === 'intent.permitted'
          && (frame.payload.data as JsonObject).permit_id === data.permit_id);
        if (permitted) extra.push(permitted.frame_hash, permitted.payload_hash);
        extra.push(...(data.reference_hashes as string[]));
        if (data.type === 'outcome.resolved') extra.push(data.previous_outcome_frame_hash);
      }
    }
    if (data.type === 'computer.referenced') {
      const computer = this.computer.find((frame) => frame.frame_hash === data.computer_frame_hash);
      if (computer) extra.push(computer.frame_hash, computer.payload_hash);
    }
    this.body.push(buildEvidenceFrame({
      streamId: BODY, utc: this.utc, head: this.body.length ? frameHead(this.body.at(-1)!) : null,
      eventKind: data.type, subject: payload.subject, dataHash: hashValue(PARTICLE_DOMAIN, payload.data),
      referenceHashes: [...new Set([source.frame_hash, source.payload_hash, ...extra])].sort(),
    }));
    return source;
  }
  input() {
    return {
      agentId: scope.agent_id, workspaceId: scope.workspace_id,
      body: this.body.length ? scan(this.body) : null, memory: this.memory.length ? scan(this.memory) : null,
      ...(this.computer.length ? { computer: scan(this.computer) } : {}),
    };
  }
  projection() { return reduceWorkspace(this.input()); }
}
function ready(needsApproval = false) {
  const h = new History();
  h.add({ type: 'agent.created', name: 'Analyst', instructions: 'Do serious business work', provider: 'github-copilot',
    tool_policy: { ...policy, approval_required: needsApproval ? ['guest.files.write'] : [] } });
  h.add({ type: 'task.created', task_id: 'task-a', ...template });
  h.add({ type: 'run.started', task_id: 'task-a', run_id: 'run-a', attempt: 1 });
  return h;
}
function accept(h: History, approved = false) {
  if (approved) {
    h.add({ type: 'approval.requested', task_id: 'task-a', approval_id: 'approval-a', principal_id: 'alice',
      operation_hash: operationHash(request), resources: request.resources, expires_utc: request.expires_utc });
    h.add({ type: 'approval.decided', task_id: 'task-a', approval_id: 'approval-a', decision: 'approved', decided_by: 'alice' });
  }
  return h.add({ type: 'intent.accepted', task_id: 'task-a', run_id: 'run-a', intent_id: 'intent-a', request, approval_id: approved ? 'approval-a' : null });
}
function permit(h: History, accepted: RappFrame, approval = false, patch: JsonObject = {}) {
  return h.add({
    type: 'intent.permitted', task_id: 'task-a', run_id: 'run-a', intent_id: 'intent-a', intent_frame_hash: accepted.frame_hash,
    permit_id: 'permit-a', operation_hash: operationHash(request), approval_id: approval ? 'approval-a' : null,
    principal_id: 'alice', expires_utc: request.expires_utc, ...patch,
  });
}
function outcome(h: History, accepted: RappFrame, patch: JsonObject = {}) {
  return h.add({
    type: 'outcome.recorded', task_id: 'task-a', run_id: 'run-a', intent_id: 'intent-a', intent_frame_hash: accepted.frame_hash,
    permit_id: 'permit-a', operation_hash: operationHash(request), status: 'success', result: { written: true },
    error: null, reference_hashes: [], ...patch,
  });
}
function computerHistory(states: ComputerObservation['state'][] = ['stopped', 'starting', 'running']): RappFrame[] {
  const frames: RappFrame[] = [];
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    frames.push(buildFrame({
      kind: 'body.pulse', streamId: COMPUTER, utc: UTC, head: frames.length ? frameHead(frames.at(-1)!) : null,
      payload: buildComputerPayload({ type: 'computer.observed', computer_id: 'omarchy', observation_id: `obs-${i}`,
        state, lease_id: ['stopped', 'unavailable'].includes(state) ? null : 'lease-a', detail: null }),
    }));
  }
  return frames;
}

describe('validated application payloads use only canonical frame kinds', () => {
  it('round-trips exact payloads and rejects event/subject/authority substitution', () => {
    const value = { ...scope, type: 'task.created', task_id: 'task/a', ...template } as DomainEvent;
    const payload = buildDomainPayload(value);
    expect(payload.subject).toBe('task:agent-a/task%2Fa');
    expect(Object.keys(payload).sort()).toEqual(['data', 'protocol_revision', 'subject']);
    expect(validateDomainPayload(JSON.parse(canonicalJson(payload)))).toEqual(payload);
    expect(eventFrameKind('message.recorded')).toBe('memory.chat-turn');
    expect(eventFrameKind('intent.accepted')).toBe('memory.tool-call');
    expect(eventFrameKind('approval.requested')).toBe('memory.save');
    for (const patch of [
      { subject: 'task:foreign/task%2Fa' }, { protocol_revision: { ...AUTHORITY_IDENTITY, revision: 'rev-13' } },
      { extra: true }, { data: { ...value, type: 'task.hacked' } },
    ]) expect(() => validateDomainPayload({ ...payload, ...patch })).toThrow();
  });
  it.each(Object.keys(EVENT_FIELDS) as EventType[])('every event type %s has one exact mapped registered frame kind', (type) => {
    expect(['memory.save', 'memory.tool-call', 'memory.chat-turn']).toContain(eventFrameKind(type));
    expect(Object.isFrozen(EVENT_FIELDS[type])).toBe(true);
  });
  it.each([
    { type: 'task.created', task_id: 't', ...template, max_attempts: 0 },
    { type: 'task.created', task_id: 't', ...template, max_attempts: 11 },
    { type: 'task.created', task_id: 't', ...template, max_attempts: 1.5 },
    { type: 'task.created', task_id: 't', ...template, title: '' },
    { type: 'agent.paused', reason: null },
    { type: 'task.status-changed', task_id: 't', status: 'succeeded', reason: null },
    { type: 'message.recorded', message_id: 'm', task_id: null, role: 'channel', content: 'x', reference_hashes: [] },
    { type: 'artifact.registered', artifact_id: 'a', task_id: 't', run_id: null, path: '../secret', sha256: 'a'.repeat(64), bytes: 1, media_type: 'text/plain' },
    { type: 'artifact.registered', artifact_id: 'a', task_id: 't', run_id: null, path: 'safe', sha256: 'a'.repeat(64), bytes: -1, media_type: 'text/plain' },
    { type: 'run.finished', task_id: 't', run_id: 'r', status: 'succeeded', error: 'but failed' },
    { type: 'run.finished', task_id: 't', run_id: 'r', status: 'failed', error: null },
    { type: 'run.checkpointed', task_id: 't', run_id: 'r', checkpoint_index: 0, checkpoint: [] },
    { type: 'memory.recorded', memory_id: 'm', task_id: null, content: 'x', source_hashes: ['a'.repeat(64), 'a'.repeat(64)] },
  ])('rejects hostile typed event %j', (value) => expect(() => validateEvent({ ...scope, ...value })).toThrow());
  it('rejects executable/proxy/extra/unknown fields without invoking them', () => {
    let calls = 0;
    const event = Object.defineProperty({ ...scope, type: 'agent.resumed' }, 'payload', { get() { calls++; return {}; }, enumerable: true });
    expect(() => validateEvent(event)).toThrow();
    expect(() => validateEvent({ ...scope, type: 'agent.created', name: 'x', instructions: 'x', provider: 'other',
      tool_policy: policy })).toThrow();
    expect(() => validateEvent({ ...scope, type: 'agent.created', name: 'x', instructions: 'x', provider: 'github-copilot',
      tool_policy: { operations: ['host.shell'], approval_required: [] } })).toThrow();
    expect(() => validateEvent({ ...scope, type: '__proto__' })).toThrow();
    expect(() => eventFrameKind('unknown.event' as EventType)).toThrow();
    expect(calls).toBe(0);
  });
});

describe('domain projections rebuilt from canonical frames alone', () => {
  it('reconstructs agents, tasks, schedules, runs, messages, memories, approvals, artifacts, computer, intents and outcomes', () => {
    const h = ready(true);
    h.computer = computerHistory();
    h.add({ type: 'message.recorded', message_id: 'message-a', task_id: 'task-a', role: 'user', content: 'Prepare the report', reference_hashes: [] });
    h.add({ type: 'memory.recorded', memory_id: 'memory-a', task_id: 'task-a', content: 'Use reviewed source documents', source_hashes: [] });
    h.add({ type: 'schedule.created', schedule_id: 'schedule-a', name: 'Hourly report', task_template: template, cadence: { kind: 'interval', seconds: 3600 }, next_utc: UTC });
    h.add({ type: 'task.created', task_id: 'scheduled-task', ...template });
    h.add({ type: 'schedule.fired', schedule_id: 'schedule-a', task_id: 'scheduled-task', scheduled_utc: UTC, next_utc: new Date(NOW + 3_600_000).toISOString() });
    h.add({ type: 'run.checkpointed', task_id: 'task-a', run_id: 'run-a', checkpoint_index: 0, checkpoint: { plan: 'Write report' } });
    const accepted = accept(h, true);
    permit(h, accepted, true);
    h.add({ type: 'computer.referenced', task_id: 'task-a', run_id: 'run-a', computer_id: 'omarchy', computer_frame_hash: h.computer.at(-1)!.frame_hash });
    outcome(h, accepted);
    h.add({ type: 'artifact.registered', artifact_id: 'artifact-a', task_id: 'task-a', run_id: 'run-a', path: 'reports/output.txt', sha256: 'd'.repeat(64), bytes: 14, media_type: 'text/plain' });
    h.add({ type: 'run.checkpointed', task_id: 'task-a', run_id: 'run-a', checkpoint_index: 1, checkpoint: { verified: true } });
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-a', status: 'succeeded', error: null });
    h.add({ type: 'schedule.paused', schedule_id: 'schedule-a' });
    h.add({ type: 'schedule.resumed', schedule_id: 'schedule-a' });
    h.add({ type: 'schedule.updated', schedule_id: 'schedule-a', name: 'Cron report', task_template: template,
      cadence: { kind: 'cron', expression: '0 * * * *', time_zone: 'UTC' }, next_utc: new Date(NOW + 3_600_000).toISOString() });
    h.add({ type: 'schedule.retired', schedule_id: 'schedule-a' });
    h.add({ type: 'agent.paused', reason: 'Maintenance' });
    h.add({ type: 'agent.resumed' });
    h.add({ type: 'agent.configured', name: 'Report Analyst', instructions: 'Reviewed reports only', provider: 'github-copilot', tool_policy: policy });
    const projection = h.projection();
    expect(projection.agent?.name).toBe('Report Analyst');
    expect(projection.tasks['task-a']).toMatchObject({ status: 'succeeded', attempts: 1, activeRunId: null });
    expect(projection.tasks['scheduled-task']?.scheduledBy).toBe('schedule-a');
    expect(projection.runs['run-a']).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(projection.runs['run-a']?.checkpoints).toHaveLength(2);
    expect(projection.schedules['schedule-a']?.status).toBe('retired');
    expect(projection.approvals['approval-a']).toMatchObject({ decision: 'approved', consumedBy: 'permit-a' });
    expect(projection.artifacts['artifact-a']).toMatchObject({ path: 'reports/output.txt', status: 'available' });
    expect(projection.messages).toHaveLength(1);
    expect(projection.memories['memory-a']?.content).toContain('reviewed');
    expect(projection.computer?.state).toBe('running');
    expect(projection.computerReferences).toHaveLength(1);
    expect(projection.intents['intent-a']?.status).toBe('success');
    expect(projection.outcomes['intent-a']?.result).toEqual({ written: true });
    expect(projection.unresolvedIntentIds).toEqual([]);
    const diskOnly = new History();
    diskOnly.body = h.body.map((frame) => JSON.parse(canonicalJson(frame)));
    diskOnly.memory = h.memory.map((frame) => JSON.parse(canonicalJson(frame)));
    diskOnly.computer = h.computer.map((frame) => JSON.parse(canonicalJson(frame)));
    expect(diskOnly.projection()).toEqual(projection);
    expect(Object.isFrozen(projection.tasks['task-a'])).toBe(true);
    expect(() => { projection.tasks['task-a']!.status = 'failed'; }).toThrow();
    h.add({ type: 'artifact.removed', artifact_id: 'artifact-a', task_id: 'task-a', reason: 'Retention request' });
    h.add({ type: 'agent.retired', reason: 'Work complete' });
    expect(h.projection().agent?.status).toBe('retired');
    expect(h.projection().artifacts['artifact-a']?.status).toBe('removed');
  });
  it('returns empty projections only for truly empty histories, never synthetic state', () => {
    const h = new History();
    expect(h.projection().agent).toBeNull();
    expect(h.projection().tasks).toEqual({});
    h.add({ type: 'agent.created', name: 'Worker', instructions: 'Work', provider: 'github-copilot', tool_policy: policy });
    expect(() => reduceWorkspace({ ...h.input(), body: null })).toThrow();
  });
  it('rejects lookalike scans, advanced/uncommitted heads, foreign ownership, wrong kind and absent evidence', () => {
    const h = ready();
    const input = h.input();
    expect(() => reduceWorkspace({ ...input, memory: { ...input.memory! } })).toThrow();
    expect(() => reduceWorkspace({ ...input, agentId: 'another' })).toThrow();
    expect(() => reduceWorkspace({ ...input, workspaceId: 'another' })).toThrow();
    expect(() => reduceWorkspace({ ...input, memory: scan(h.memory, h.memory[0]!) })).toThrow();
    for (const options of [{ evidence: false }, { kind: 'memory.tool-call' }, { payloadPatch: { subject: 'wrong:subject' } }]) {
      const other = ready();
      other.add({ type: 'task.created', task_id: 'task-b', ...template }, options);
      expect(() => other.projection()).toThrow();
    }
  });
  it('uses own-key dictionaries for hostile-looking but valid resource IDs', () => {
    const h = ready();
    h.add({ type: 'task.created', task_id: '__proto__', ...template });
    const projection = h.projection();
    expect(Object.getPrototypeOf(projection.tasks)).toBeNull();
    expect(Object.hasOwn(projection.tasks, '__proto__')).toBe(true);
    expect(projection.tasks.__proto__?.status).toBe('queued');
  });
});

describe('durable state-machine refusal and crash outcomes', () => {
  it.each([
    { type: 'agent.created', name: 'Duplicate', instructions: 'x', provider: 'github-copilot', tool_policy: policy },
    { type: 'agent.configured', name: 'During run', instructions: 'x', provider: 'github-copilot', tool_policy: policy },
    { type: 'agent.retired', reason: 'Still running' },
    { type: 'task.created', task_id: 'task-a', ...template },
    { type: 'task.updated', task_id: 'task-a', title: 'Changed active instructions', instructions: 'x' },
    { type: 'task.status-changed', task_id: 'task-a', status: 'cancelled', reason: 'Not a run cancellation' },
    { type: 'run.started', task_id: 'task-a', run_id: 'other', attempt: 2 },
    { type: 'run.checkpointed', task_id: 'task-a', run_id: 'run-a', checkpoint_index: 2, checkpoint: {} },
    { type: 'run.checkpointed', task_id: 'task-b', run_id: 'run-a', checkpoint_index: 0, checkpoint: {} },
    { type: 'task.retried', task_id: 'task-a', reason: 'Blindly replay' },
  ])('rejects illegal transition %j', (event) => {
    const h = ready(); h.add(event); expect(() => h.projection()).toThrow();
  });
  it('supports bounded explicit retries, never an automatic third attempt', () => {
    const h = ready();
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-a', status: 'failed', error: 'Provider failed before execution' });
    h.add({ type: 'task.retried', task_id: 'task-a', reason: 'Explicit authorized retry' });
    h.add({ type: 'run.started', task_id: 'task-a', run_id: 'run-b', attempt: 2 });
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-b', status: 'failed', error: 'Provider failed again' });
    expect(h.projection().tasks['task-a']).toMatchObject({ status: 'failed', attempts: 2 });
    h.add({ type: 'task.retried', task_id: 'task-a', reason: 'Attempt three' });
    expect(() => h.projection()).toThrow();
  });
  it('rebuilds spent permits without outcomes as unresolved and blocks replay', () => {
    const h = ready();
    const accepted = accept(h); permit(h, accepted);
    const projection = h.projection();
    expect(projection.runs['run-a']?.status).toBe('unresolved');
    expect(projection.tasks['task-a']?.status).toBe('blocked');
    expect(projection.unresolvedIntentIds).toEqual(['intent-a']);
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-a', status: 'succeeded', error: null });
    expect(() => h.projection()).toThrow();
  });
  it('requires an explicit canonical reconciliation of an unresolved outcome, without re-execution', () => {
    const h = ready(), accepted = accept(h);
    permit(h, accepted);
    const unknown = outcome(h, accepted, { status: 'unresolved', result: null, error: 'Connection lost after dispatch' });
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-a', status: 'unresolved', error: 'Outcome unknown' });
    expect(h.projection().runs['run-a']?.status).toBe('unresolved');
    outcome(h, accepted, { type: 'outcome.resolved', previous_outcome_frame_hash: unknown.frame_hash });
    h.add({ type: 'run.resolved', task_id: 'task-a', run_id: 'run-a', status: 'succeeded', error: null });
    const result = h.projection();
    expect(result.runs['run-a']?.status).toBe('succeeded');
    expect(result.unresolvedIntentIds).toEqual([]);
    expect(result.outcomes['intent-a']?.previousOutcomeFrameHash).toBe(unknown.frame_hash);
    expect(h.memory.filter((frame) => (frame.payload.data as JsonObject).type === 'intent.permitted')).toHaveLength(1);
  });
  it('can cancel an accepted, not-yet-permitted intent without claiming an effect', () => {
    const h = ready(), accepted = accept(h);
    h.add({ type: 'run.cancel-requested', task_id: 'task-a', run_id: 'run-a', reason: 'User cancelled' });
    outcome(h, accepted, { status: 'cancelled', result: null, error: 'Cancelled before execution', permit_id: null });
    h.add({ type: 'run.finished', task_id: 'task-a', run_id: 'run-a', status: 'cancelled', error: 'Cancelled' });
    expect(h.projection().tasks['task-a']?.status).toBe('cancelled');
  });
  it('rejects success without a permit, reused permits/outcomes, or issuance after cancellation', () => {
    const missing = ready(), accepted = accept(missing);
    outcome(missing, accepted, { permit_id: null });
    expect(() => missing.projection()).toThrow();
    const repeated = ready(), intent = accept(repeated);
    permit(repeated, intent); permit(repeated, intent);
    expect(() => repeated.projection()).toThrow();
    const duplicateOutcome = ready(), accepted2 = accept(duplicateOutcome);
    permit(duplicateOutcome, accepted2); outcome(duplicateOutcome, accepted2); outcome(duplicateOutcome, accepted2);
    expect(() => duplicateOutcome.projection()).toThrow();
    const cancelled = ready(), accepted3 = accept(cancelled);
    cancelled.add({ type: 'run.cancel-requested', task_id: 'task-a', run_id: 'run-a', reason: 'Stop' });
    permit(cancelled, accepted3);
    expect(() => cancelled.projection()).toThrow();
  });
  it.each([
    { principal_id: 'bob' }, { operation_hash: 'c'.repeat(64) }, { intent_frame_hash: 'd'.repeat(64) },
    { approval_id: 'different' }, { expires_utc: UTC },
    { expires_utc: new Date(NOW + 120_000).toISOString() },
  ])('rejects substituted permit fields %j', (patch) => {
    const h = ready(true), accepted = accept(h, true);
    permit(h, accepted, true, patch);
    expect(() => h.projection()).toThrow();
  });
  it('checks approval expiry and the exact operation resources before permission can be consumed', () => {
    const h = ready(true);
    h.add({ type: 'approval.requested', task_id: 'task-a', approval_id: 'approval-a', principal_id: 'alice',
      operation_hash: operationHash(request), resources: request.resources, expires_utc: new Date(NOW + 1000).toISOString() });
    h.utc = new Date(NOW + 1000).toISOString();
    h.add({ type: 'approval.decided', task_id: 'task-a', approval_id: 'approval-a', decision: 'approved', decided_by: 'alice' });
    expect(() => h.projection()).toThrow();
    const wrong = ready(true);
    wrong.add({ type: 'approval.requested', task_id: 'task-a', approval_id: 'approval-a', principal_id: 'alice',
      operation_hash: operationHash(request), resources: ['computer:omarchy'], expires_utc: request.expires_utc });
    wrong.add({ type: 'intent.accepted', task_id: 'task-a', run_id: 'run-a', intent_id: 'intent-a', request, approval_id: 'approval-a' });
    expect(() => wrong.projection()).toThrow();
  });
  it('forbids new execution for paused or retired agents', () => {
    const paused = ready();
    paused.add({ type: 'agent.paused', reason: 'Pause' });
    accept(paused);
    expect(() => paused.projection()).toThrow();
    const retired = new History();
    retired.add({ type: 'agent.created', name: 'a', instructions: 'x', provider: 'github-copilot', tool_policy: policy });
    retired.add({ type: 'agent.retired', reason: 'Retired' });
    retired.add({ type: 'task.created', task_id: 'task-a', ...template });
    expect(() => retired.projection()).toThrow();
  });
});

describe('business schedules, artifact lifetimes and shared computer observations', () => {
  it.each([
    { kind: 'interval', seconds: 0 }, { kind: 'interval', seconds: 1.5 },
    { kind: 'cron', expression: '0 0 0 * * *', time_zone: 'UTC' },
    { kind: 'cron', expression: '60 * * * *', time_zone: 'UTC' },
    { kind: 'cron', expression: '0 * * * *', time_zone: 'Not/AZone' },
    { kind: 'cron', expression: '0 25 * * *', time_zone: 'UTC' },
    { kind: 'cron', expression: '*/0 * * * *', time_zone: 'UTC' },
    { kind: 'cron', expression: '10-1 * * * *', time_zone: 'UTC' },
    { kind: 'cron', expression: '@daily', time_zone: 'UTC' },
  ])('rejects malformed cadence %j', (value) => expect(() => validateCadence(value)).toThrow());
  it('handles queued task edits and rejects early, duplicate or template-substituted firings', () => {
    const h = ready();
    h.add({ type: 'task.created', task_id: 'queued-task', ...template });
    h.add({ type: 'task.status-changed', task_id: 'queued-task', status: 'blocked', reason: 'Waiting for inputs' });
    h.add({ type: 'task.updated', task_id: 'queued-task', title: 'Updated title', instructions: 'Updated instructions' });
    h.add({ type: 'task.status-changed', task_id: 'queued-task', status: 'queued', reason: null });
    expect(h.projection().tasks['queued-task']?.title).toBe('Updated title');
    h.add({ type: 'schedule.created', schedule_id: 's', name: 'Recurring', task_template: template,
      cadence: { kind: 'interval', seconds: 60 }, next_utc: UTC });
    h.add({ type: 'schedule.fired', schedule_id: 's', task_id: 'queued-task', scheduled_utc: UTC, next_utc: new Date(NOW + 60_000).toISOString() });
    expect(() => h.projection()).toThrow();
  });
  it('rejects artifact path/id reuse and cross-task removal', () => {
    const h = ready();
    h.add({ type: 'artifact.registered', artifact_id: 'a', task_id: 'task-a', run_id: 'run-a', path: 'report.txt', sha256: 'a'.repeat(64), bytes: 12, media_type: 'text/plain' });
    h.add({ type: 'artifact.removed', artifact_id: 'a', task_id: 'task-a', reason: 'Archive' });
    h.add({ type: 'artifact.registered', artifact_id: 'b', task_id: 'task-a', run_id: 'run-a', path: 'report.txt', sha256: 'b'.repeat(64), bytes: 12, media_type: 'text/plain' });
    expect(() => h.projection()).toThrow();
  });
  it('rebuilds only observed computer lifecycle states from its own body history', () => {
    const frames = computerHistory(['unavailable', 'stopped', 'starting', 'running', 'stopping', 'stopped']);
    const result = reduceComputerHistory(scan(frames));
    expect(result.state).toBe('stopped');
    expect(result.leaseId).toBeNull();
    expect(result.observations).toHaveLength(6);
    expect(() => reduceComputerHistory({ ...scan(frames) })).toThrow();
    expect(() => reduceComputerHistory(scan(computerHistory(['stopped', 'running'])))).toThrow();
    expect(() => reduceComputerHistory(scan(computerHistory(['stopped', 'stopped'])))).toThrow();
    expect(() => validateComputerObservation({ type: 'computer.observed', computer_id: 'host-shell', observation_id: 'x', state: 'running', lease_id: 'l', detail: null })).toThrow();
    expect(() => validateComputerObservation({ type: 'computer.observed', computer_id: 'omarchy', observation_id: 'x', state: 'running', lease_id: null, detail: null })).toThrow();
  });
  it('refuses agent-local computer claims without the shared computer receipt', () => {
    const h = ready();
    h.add({ type: 'computer.referenced', task_id: 'task-a', run_id: 'run-a', computer_id: 'omarchy', computer_frame_hash: 'b'.repeat(64) });
    expect(() => h.projection()).toThrow();
  });
});
