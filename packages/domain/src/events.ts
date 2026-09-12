import {
  AUTHORITY_IDENTITY, HEX64, arrayItems, assertOptions, canonicalJson, isJsonObject, isUtc, snapshotJson,
  type AuthorityIdentity, type JsonObject, type JsonValue,
} from '@rapp-work/rapp1';
import {
  artifactPath, assertIdentifier, GUEST_OPERATIONS, resourceList, validateOperation,
  type GuestOperation, type OperationRequest,
} from '@rapp-work/security';

export interface ToolPolicy extends JsonObject {
  operations: GuestOperation[];
  approval_required: GuestOperation[];
}
export interface TaskTemplate extends JsonObject { title: string; instructions: string; max_attempts: number }
export type Cadence = ({ kind: 'interval'; seconds: number } | { kind: 'cron'; expression: string; time_zone: string }) & JsonObject;
interface Base extends JsonObject { agent_id: string; workspace_id: string }
export interface EventFields {
  'agent.created': { name: string; instructions: string; provider: 'github-copilot'; tool_policy: ToolPolicy };
  'agent.configured': { name: string; instructions: string; provider: 'github-copilot'; tool_policy: ToolPolicy };
  'agent.paused': { reason: string };
  'agent.resumed': Record<never, never>;
  'agent.retired': { reason: string };
  'task.created': { task_id: string; title: string; instructions: string; max_attempts: number };
  'task.updated': { task_id: string; title: string; instructions: string };
  'task.status-changed': { task_id: string; status: 'queued' | 'blocked' | 'cancelled'; reason: string | null };
  'task.retried': { task_id: string; reason: string };
  'schedule.created': { schedule_id: string; name: string; task_template: TaskTemplate; cadence: Cadence; next_utc: string };
  'schedule.updated': { schedule_id: string; name: string; task_template: TaskTemplate; cadence: Cadence; next_utc: string };
  'schedule.paused': { schedule_id: string };
  'schedule.resumed': { schedule_id: string };
  'schedule.retired': { schedule_id: string };
  'schedule.fired': { schedule_id: string; task_id: string; scheduled_utc: string; next_utc: string };
  'run.started': { task_id: string; run_id: string; attempt: number };
  'run.checkpointed': { task_id: string; run_id: string; checkpoint_index: number; checkpoint: JsonObject };
  'run.cancel-requested': { task_id: string; run_id: string; reason: string };
  'run.finished': { task_id: string; run_id: string; status: 'succeeded' | 'failed' | 'cancelled' | 'unresolved'; error: string | null };
  'run.resolved': { task_id: string; run_id: string; status: 'succeeded' | 'failed' | 'cancelled'; error: string | null };
  'approval.requested': {
    task_id: string; approval_id: string; principal_id: string; operation_hash: string;
    resources: string[]; expires_utc: string;
  };
  'approval.decided': { task_id: string; approval_id: string; decision: 'approved' | 'denied'; decided_by: string };
  'message.recorded': {
    message_id: string; task_id: string | null; role: 'user' | 'assistant' | 'system'; content: string; reference_hashes: string[];
  };
  'memory.recorded': { memory_id: string; task_id: string | null; content: string; source_hashes: string[] };
  'artifact.registered': {
    artifact_id: string; task_id: string; run_id: string | null; path: string; sha256: string; bytes: number; media_type: string;
  };
  'artifact.removed': { artifact_id: string; task_id: string; reason: string };
  'computer.referenced': { task_id: string; run_id: string; computer_id: 'omarchy'; computer_frame_hash: string };
  'intent.accepted': {
    task_id: string; run_id: string; intent_id: string; request: OperationRequest; approval_id: string | null;
  };
  'intent.permitted': {
    task_id: string; run_id: string; intent_id: string; intent_frame_hash: string; permit_id: string;
    operation_hash: string; approval_id: string | null; principal_id: string; expires_utc: string;
  };
  'outcome.recorded': {
    task_id: string; run_id: string; intent_id: string; intent_frame_hash: string; permit_id: string | null;
    operation_hash: string; status: 'success' | 'error' | 'cancelled' | 'unresolved'; result: JsonObject | null;
    error: string | null; reference_hashes: string[];
  };
  'outcome.resolved': {
    task_id: string; run_id: string; intent_id: string; intent_frame_hash: string; permit_id: string;
    operation_hash: string; previous_outcome_frame_hash: string; status: 'success' | 'error' | 'cancelled';
    result: JsonObject | null; error: string | null; reference_hashes: string[];
  };
}
export type EventType = keyof EventFields;
export type DomainEvent = { [K in EventType]: Base & { type: K } & EventFields[K] }[EventType];
export interface DomainPayload extends JsonObject {
  subject: string;
  data: DomainEvent;
  protocol_revision: AuthorityIdentity;
}
export class DomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DomainError'; }
}
export const EVENT_FIELDS: Readonly<Record<EventType, readonly string[]>> = Object.freeze({
  'agent.created': ['name', 'instructions', 'provider', 'tool_policy'],
  'agent.configured': ['name', 'instructions', 'provider', 'tool_policy'],
  'agent.paused': ['reason'], 'agent.resumed': [], 'agent.retired': ['reason'],
  'task.created': ['task_id', 'title', 'instructions', 'max_attempts'],
  'task.updated': ['task_id', 'title', 'instructions'],
  'task.status-changed': ['task_id', 'status', 'reason'], 'task.retried': ['task_id', 'reason'],
  'schedule.created': ['schedule_id', 'name', 'task_template', 'cadence', 'next_utc'],
  'schedule.updated': ['schedule_id', 'name', 'task_template', 'cadence', 'next_utc'],
  'schedule.paused': ['schedule_id'], 'schedule.resumed': ['schedule_id'], 'schedule.retired': ['schedule_id'],
  'schedule.fired': ['schedule_id', 'task_id', 'scheduled_utc', 'next_utc'],
  'run.started': ['task_id', 'run_id', 'attempt'],
  'run.checkpointed': ['task_id', 'run_id', 'checkpoint_index', 'checkpoint'],
  'run.cancel-requested': ['task_id', 'run_id', 'reason'],
  'run.finished': ['task_id', 'run_id', 'status', 'error'], 'run.resolved': ['task_id', 'run_id', 'status', 'error'],
  'approval.requested': ['task_id', 'approval_id', 'principal_id', 'operation_hash', 'resources', 'expires_utc'],
  'approval.decided': ['task_id', 'approval_id', 'decision', 'decided_by'],
  'message.recorded': ['message_id', 'task_id', 'role', 'content', 'reference_hashes'],
  'memory.recorded': ['memory_id', 'task_id', 'content', 'source_hashes'],
  'artifact.registered': ['artifact_id', 'task_id', 'run_id', 'path', 'sha256', 'bytes', 'media_type'],
  'artifact.removed': ['artifact_id', 'task_id', 'reason'],
  'computer.referenced': ['task_id', 'run_id', 'computer_id', 'computer_frame_hash'],
  'intent.accepted': ['task_id', 'run_id', 'intent_id', 'request', 'approval_id'],
  'intent.permitted': ['task_id', 'run_id', 'intent_id', 'intent_frame_hash', 'permit_id', 'operation_hash', 'approval_id', 'principal_id', 'expires_utc'],
  'outcome.recorded': ['task_id', 'run_id', 'intent_id', 'intent_frame_hash', 'permit_id', 'operation_hash', 'status', 'result', 'error', 'reference_hashes'],
  'outcome.resolved': ['task_id', 'run_id', 'intent_id', 'intent_frame_hash', 'permit_id', 'operation_hash', 'previous_outcome_frame_hash', 'status', 'result', 'error', 'reference_hashes'],
});
for (const fields of Object.values(EVENT_FIELDS)) Object.freeze(fields);

function text(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64_000 || value.normalize('NFC') !== value) {
    throw new DomainError('text', `Invalid ${label}`);
  }
}
function integer(value: unknown, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new DomainError('integer', 'Integer outside supported bounds');
}
function oneOf(value: unknown, values: readonly string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) throw new DomainError('enum', 'Unrecognized domain state');
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new DomainError('hash', 'Expected a complete lowercase SHA-256');
}
function hashes(value: unknown): void {
  let previous = '';
  for (const item of arrayItems(value, 256)) {
    hash(item);
    if ((item as string) <= previous) throw new DomainError('hashes', 'References must be sorted and unique');
    previous = item as string;
  }
}
function toolPolicy(value: unknown): void {
  assertOptions(value, ['operations', 'approval_required']);
  const operations = arrayItems(value.operations);
  const approvals = arrayItems(value.approval_required);
  if (new Set(operations).size !== operations.length || new Set(approvals).size !== approvals.length
    || operations.some((op) => !GUEST_OPERATIONS.includes(op as GuestOperation))
    || approvals.some((op) => !operations.includes(op))) throw new DomainError('tool-policy', 'Invalid guest-only tool policy');
}
function template(value: unknown): void {
  assertOptions(value, ['title', 'instructions', 'max_attempts']);
  text(value.title, 'task title'); text(value.instructions, 'instructions'); integer(value.max_attempts, 1, 10);
}

export function validateCadence(value: unknown): Cadence {
  const cadence = snapshotJson(value);
  if (!isJsonObject(cadence)) throw new DomainError('cadence', 'Schedule cadence must be an object');
  if (cadence.kind === 'interval') {
    assertOptions(cadence, ['kind', 'seconds']);
    integer(cadence.seconds, 1, 366 * 86400);
  } else if (cadence.kind === 'cron') {
    assertOptions(cadence, ['kind', 'expression', 'time_zone']);
    if (typeof cadence.expression !== 'string' || cadence.expression.length > 256
      || typeof cadence.time_zone !== 'string') throw new DomainError('cadence', 'Invalid cron expression or time zone');
    const fields = cadence.expression.split(' ');
    if (fields.length !== 5) throw new DomainError('cadence', 'Cron requires exactly five fields');
    const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
    for (let i = 0; i < fields.length; i++) {
      for (const part of fields[i]!.split(',')) {
        const match = /^(\*|\d+(?:-\d+)?)(?:\/([1-9]\d*))?$/.exec(part);
        if (!match) throw new DomainError('cadence', 'Invalid cron field');
        const [min, max] = limits[i]!;
        if (match[2]) integer(Number(match[2]), 1, max - min + 1);
        if (match[1] !== '*') {
          const ends = match[1]!.split('-').map(Number);
          for (const end of ends) integer(end, min, max);
          if (ends.length === 2 && ends[0]! > ends[1]!) throw new DomainError('cadence', 'Descending cron range');
        }
      }
    }
    try { new Intl.DateTimeFormat('en-US', { timeZone: cadence.time_zone }); }
    catch { throw new DomainError('cadence', 'Unknown IANA time zone'); }
  } else throw new DomainError('cadence', 'Unknown cadence');
  return cadence as Cadence;
}

export function validateEvent(value: unknown): DomainEvent {
  const event = snapshotJson(value);
  if (!isJsonObject(event) || typeof event.type !== 'string' || !Object.hasOwn(EVENT_FIELDS, event.type)) {
    throw new DomainError('event-type', 'Unknown event; no partial/compatibility projection');
  }
  const type = event.type as EventType;
  assertOptions(event, ['type', 'agent_id', 'workspace_id', ...EVENT_FIELDS[type]]);
  assertIdentifier(event.agent_id, 'agent'); assertIdentifier(event.workspace_id, 'workspace');
  for (const [key, item] of Object.entries(event)) {
    if (key.endsWith('_id')) {
      const nullable = (key === 'task_id' && ['message.recorded', 'memory.recorded'].includes(type))
        || (key === 'run_id' && type === 'artifact.registered')
        || (key === 'approval_id' && type.startsWith('intent.'))
        || (key === 'permit_id' && type === 'outcome.recorded');
      if (item !== null || !nullable) assertIdentifier(item, key);
    }
    if (key.endsWith('_hash') || key === 'sha256') hash(item);
    if (key.endsWith('_utc') && !isUtc(item)) throw new DomainError('utc', 'Invalid event timestamp');
    if (['title', 'name', 'instructions', 'content', 'decided_by'].includes(key)) text(item, key);
    if (key === 'reason' || key === 'error') {
      if (item !== null || (key === 'reason' && type !== 'task.status-changed')) text(item, key);
    }
    if (key === 'reference_hashes' || key === 'source_hashes') hashes(item);
  }
  switch (type) {
    case 'agent.created': case 'agent.configured':
      oneOf(event.provider, ['github-copilot']); toolPolicy(event.tool_policy); break;
    case 'task.created': integer(event.max_attempts, 1, 10); break;
    case 'task.status-changed': oneOf(event.status, ['queued', 'blocked', 'cancelled']); break;
    case 'schedule.created': case 'schedule.updated': template(event.task_template); validateCadence(event.cadence); break;
    case 'run.started': integer(event.attempt, 1, 10); break;
    case 'run.checkpointed':
      integer(event.checkpoint_index, 0, Number.MAX_SAFE_INTEGER);
      if (!isJsonObject(event.checkpoint!)) throw new DomainError('checkpoint', 'Checkpoint must be JSON data'); break;
    case 'run.finished': case 'run.resolved':
      oneOf(event.status, type === 'run.finished' ? ['succeeded', 'failed', 'cancelled', 'unresolved'] : ['succeeded', 'failed', 'cancelled']);
      if ((event.status === 'succeeded') !== (event.error === null)) throw new DomainError('result', 'Run terminal status/error mismatch');
      break;
    case 'approval.requested': resourceList(event.resources); break;
    case 'approval.decided': oneOf(event.decision, ['approved', 'denied']); break;
    case 'message.recorded': oneOf(event.role, ['user', 'assistant', 'system']); break;
    case 'artifact.registered':
      artifactPath(event.path); integer(event.bytes, 0, 64 * 1024 * 1024);
      if (typeof event.media_type !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(event.media_type)) {
        throw new DomainError('media-type', 'Invalid artifact media type');
      }
      break;
    case 'computer.referenced': oneOf(event.computer_id, ['omarchy']); break;
    case 'intent.accepted': validateOperation(event.request); break;
    case 'outcome.recorded': case 'outcome.resolved':
      oneOf(event.status, type === 'outcome.recorded' ? ['success', 'error', 'cancelled', 'unresolved'] : ['success', 'error', 'cancelled']);
      if (event.result !== null && !isJsonObject(event.result!)) throw new DomainError('result', 'Outcome result must be JSON object or null');
      if ((event.status === 'success') !== (event.error === null)) throw new DomainError('result', 'Outcome status/error mismatch');
      if (event.status !== 'success' && event.result !== null) throw new DomainError('result', 'A non-success is not a successful result');
      break;
  }
  canonicalJson(event);
  return event as DomainEvent;
}

export function eventFrameKind(type: EventType): 'memory.save' | 'memory.tool-call' | 'memory.chat-turn' {
  if (!Object.hasOwn(EVENT_FIELDS, type)) throw new DomainError('event-type', 'Unknown domain event');
  if (type === 'message.recorded') return 'memory.chat-turn';
  if (type.startsWith('run.') || type.startsWith('intent.') || type.startsWith('outcome.') || type === 'approval.decided') return 'memory.tool-call';
  return 'memory.save';
}

function encoded(value: JsonValue): string { return encodeURIComponent(value as string); }
export function eventSubject(event: DomainEvent): string {
  const family = event.type.split('.')[0]!;
  const base = encoded(event.agent_id);
  if (family === 'agent') return `agent:${base}`;
  if (family === 'task') return `task:${base}/${encoded(event.task_id!)}`;
  if (family === 'schedule') return `schedule:${base}/${encoded(event.schedule_id!)}`;
  if (family === 'run') return `run:${base}/${encoded(event.task_id!)}/${encoded(event.run_id!)}`;
  if (family === 'intent' || family === 'outcome') return `intent:${base}/${encoded(event.task_id!)}/${encoded(event.run_id!)}/${encoded(event.intent_id!)}`;
  if (family === 'computer') return `computer:${base}/${encoded(event.task_id!)}/${encoded(event.run_id!)}`;
  return `${family}:${base}/${encoded(event[`${family}_id`]!)}`;
}

export function buildDomainPayload(event: DomainEvent): DomainPayload {
  const data = validateEvent(event);
  return snapshotJson({ subject: eventSubject(data), data, protocol_revision: AUTHORITY_IDENTITY }) as DomainPayload;
}

export function validateDomainPayload(value: unknown): DomainPayload {
  const payload = snapshotJson(value);
  assertOptions(payload, ['subject', 'data', 'protocol_revision']);
  const event = validateEvent(payload.data);
  if (payload.subject !== eventSubject(event) || canonicalJson(payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new DomainError('payload-binding', 'Subject or protocol authority was substituted');
  }
  return payload as DomainPayload;
}
