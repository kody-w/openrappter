import { AUTHORITY, canonicalJson, isBodyStream, isLabel, snapshotJson, type JsonObject, type JsonValue } from './canonical.js';
import { requireThat } from './errors.js';

export const EVENT_SCHEMA = 'rapp-work.next/event/1';
export const ROOT_SCHEMA = 'rapp-work.next/root/1';
export const PROJECTION_SCHEMA = 'rapp-work.projection/1';
export const MAX_TEXT = 12_000;
export const MAX_SCOPES = 128;

export function object(value: unknown, fields?: readonly string[], optional: readonly string[] = []): JsonObject {
  const result = snapshotJson(value);
  requireThat(result !== null && typeof result === 'object' && !Array.isArray(result),
    'contract', 'An inert JSON object is required.');
  if (fields) {
    const allowed = new Set([...fields, ...optional]);
    requireThat(Object.keys(result).every(key => allowed.has(key)) && fields.every(key => Object.hasOwn(result, key)),
      'contract', 'Missing or unknown fields are not authorized.');
  }
  return result;
}

export function text(value: unknown, max = MAX_TEXT): string {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    'contract', `Text must be nonempty and at most ${max} characters.`);
  return value;
}

export function label(value: unknown): string {
  requireThat(isLabel(value, 100), 'contract', 'A bounded lowercase label is required.');
  return value;
}

export function list(value: JsonValue | undefined, max = 32): JsonValue[] {
  requireThat(Array.isArray(value) && value.length <= max, 'contract', `A list of at most ${max} items is required.`);
  return value;
}

export type ScopeKind = 'world' | 'workspace' | 'librarian' | 'neighborhood' | 'agent' | 'twin'
  | 'factory' | 'rapplication' | 'task' | 'routine' | 'memory' | 'artifact' | 'evidence';
export interface Scope extends JsonObject {
  id: string;
  parent: string | null;
  kind: ScopeKind;
  name: string;
  description: string;
}
const SCOPE_KINDS: readonly string[] = ['world', 'workspace', 'librarian', 'neighborhood', 'agent',
  'twin', 'factory', 'rapplication', 'task', 'routine', 'memory', 'artifact', 'evidence'];

export function scope(value: unknown): Scope {
  const s = object(value, ['id', 'parent', 'kind', 'name', 'description']);
  label(s.id);
  if (s.parent !== null) label(s.parent);
  requireThat(SCOPE_KINDS.includes(String(s.kind)), 'scope', 'Unknown internal organ kind.');
  text(s.name, 120);
  text(s.description, 2_000);
  return s as Scope;
}

export function validateTree(scopes: readonly Scope[]): void {
  requireThat(scopes.length > 0 && scopes.length <= MAX_SCOPES, 'scope', 'The recursive world exceeds its bound.');
  const byId = new Map(scopes.map(s => [s.id, scope(s)]));
  requireThat(byId.size === scopes.length && byId.get('root')?.parent === null
    && byId.get('root')?.kind === 'world' && scopes.filter(s => s.kind === 'librarian').length === 1
    && byId.get('librarian')?.kind === 'librarian' && byId.get('librarian')?.parent === 'root',
  'scope', 'One root world and exactly one Workspaces Librarian are required.');
  for (const s of scopes) {
    const seen = new Set([s.id]);
    let parent = s.parent;
    while (parent !== null) {
      requireThat(!seen.has(parent) && byId.has(parent), 'scope', 'Scopes must have complete acyclic ancestry.');
      seen.add(parent);
      parent = byId.get(parent)!.parent;
    }
    requireThat(s.id === 'root' || seen.has('root'), 'scope', 'Every organ must belong to the same root.');
  }
}

export function defaultScopes(name: string): Scope[] {
  return [
    { id: 'root', parent: null, kind: 'world', name, description: 'The complete recursive world of this one RAPPbot.' },
    { id: 'librarian', parent: 'root', kind: 'librarian', name: 'Workspaces Librarian', description: 'Organizes this root only; hidden internal organ.' },
    { id: 'global-estate', parent: 'root', kind: 'world', name: 'RAPP Global Estate', description: 'Historical/derived map: RAPP foundation (https://github.com/kody-w/RAPP) and RAPP/1 protocol (https://github.com/kody-w/rapp-1). References are not live ownership or a verified current inventory.' },
    { id: 'local-estate', parent: 'root', kind: 'world', name: 'Local AI estate', description: 'Read-only native pointers from explicit discovery evidence; never copied or normalized.' },
    { id: 'monorepo', parent: 'root', kind: 'world', name: 'RAPP Monorepo', description: 'Bare canonical monorepo-shaped world; no filesystem mounting or source writes.' },
    { id: 'tasks', parent: 'monorepo', kind: 'workspace', name: 'Tasks', description: 'Scoped reversible internal work.' },
    { id: 'routines', parent: 'monorepo', kind: 'workspace', name: 'Routines', description: 'Reviewed recurring intents; schedules are hidden implementation.' },
    { id: 'memory', parent: 'monorepo', kind: 'memory', name: 'Memory', description: 'Canonical public turns and bounded outcomes, never hidden reasoning.' },
    { id: 'artifacts', parent: 'monorepo', kind: 'workspace', name: 'Artifacts', description: 'Canonical artifacts and verified capability references.' },
    { id: 'evidence', parent: 'monorepo', kind: 'evidence', name: 'Evidence', description: 'Frame-grounded evidence; integrity is not factual truth.' },
  ];
}

export interface CapabilityReference extends JsonObject {
  artifact: 'agent.py';
  sha256: string;
  contract: 'rapp-work.brainstem-agent/1';
}

export function capabilityReference(value: unknown): CapabilityReference {
  const c = object(value, ['artifact', 'sha256', 'contract']);
  requireThat(c.artifact === 'agent.py' && c.contract === 'rapp-work.brainstem-agent/1'
    && typeof c.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(c.sha256),
  'capability', 'An exact target-owned agent.py capability reference is required.');
  return c as CapabilityReference;
}

export interface RootDefinition extends JsonObject {
  schema: typeof ROOT_SCHEMA;
  operationId: string;
  root: string;
  name: string;
  scopes: Scope[];
  capability: CapabilityReference;
  authority: JsonObject;
  signer: string | null;
  policy: {
    externalEffects: 'explicit-approval';
    nativeStores: 'pointer-only';
    memory: 'public-turns-and-outcomes';
  };
}

export function rootDefinition(value: unknown): RootDefinition {
  const r = object(value, ['schema', 'operationId', 'root', 'name', 'scopes', 'capability', 'authority', 'signer', 'policy']);
  requireThat(r.schema === ROOT_SCHEMA && isBodyStream(r.root), 'root-identity', 'Invalid rooted-bot genesis.');
  label(r.operationId);
  text(r.name, 120);
  const scopes = list(r.scopes, MAX_SCOPES).map(scope);
  validateTree(scopes);
  capabilityReference(r.capability);
  requireThat(canonicalJson(r.authority) === canonicalJson(AUTHORITY), 'root-authority',
    'Rooted data must retain the exact adopted rev-15 authority; no implicit repinning is permitted.');
  requireThat(r.signer === null || r.signer === r.root, 'signer', 'A keyed bot must sign as its exact root GUID.');
  const p = object(r.policy, ['externalEffects', 'nativeStores', 'memory']);
  requireThat(p.externalEffects === 'explicit-approval' && p.nativeStores === 'pointer-only'
    && p.memory === 'public-turns-and-outcomes', 'policy', 'Root policy cannot silently expand.');
  return r as RootDefinition;
}

export interface WorkEvent extends JsonObject {
  schema: typeof EVENT_SCHEMA;
  root: string;
  scope: string;
  operationId: string;
  event: string;
  data: JsonObject;
}
const EVENTS = new Set([
  'root.visibility', 'turn.user', 'turn.assistant', 'organization.applied', 'work.progress',
  'state.corrected', 'discovery.recorded', 'routine.tick', 'collaboration.granted', 'collaboration.requested',
  'collaboration.perspective', 'collaboration.synthesized', 'provider.unavailable', 'operation.interrupted',
  'effect.approved', 'effect.outcome', 'channel.bound', 'channel.queued', 'channel.attempt', 'channel.outcome', 'hive.consented', 'hive.linked',
  'client.granted', 'client.revoked', 'client.conversation', 'client.activity', 'client.evidence', 'client.attention', 'client.view',
  'migration.root.imported', 'migration.pointer.imported',
  'computer.replay.policy', 'computer.receipt.linked',
  'channel.preflight', 'channel.preflight.outcome', 'channel.cancelled', 'channel.inbound.reviewed',
]);

export function workEvent(value: unknown): WorkEvent {
  const e = object(value, ['schema', 'root', 'scope', 'operationId', 'event', 'data'], ['parents']);
  requireThat(e.schema === EVENT_SCHEMA && isBodyStream(e.root) && EVENTS.has(String(e.event)),
    'event', 'Unknown canonical Work event.');
  label(e.scope);
  label(e.operationId);
  object(e.data);
  if (e.parents !== undefined) requireThat(Array.isArray(e.parents) && e.parents.length <= MAX_SCOPES + 1
    && new Set(e.parents).size === e.parents.length
    && e.parents.every(p => typeof p === 'string' && /^[0-9a-f]{64}$/u.test(p)), 'source-lineage', 'Only bounded unique canonical source parent references are allowed.');
  return e as WorkEvent;
}

export function eventPayload(root: string, scopeId: string, operationId: string, event: string, data: JsonObject): WorkEvent {
  return workEvent({ schema: EVENT_SCHEMA, root, scope: scopeId, operationId, event, data });
}

export function eventKind(event: string): 'memory.chat-turn' | 'memory.save' | 'memory.tool-call' {
  if (event.startsWith('turn.') || event === 'collaboration.synthesized' || event === 'client.conversation') return 'memory.chat-turn';
  if (['organization.applied', 'work.progress', 'routine.tick', 'provider.unavailable',
    'operation.interrupted', 'effect.outcome', 'channel.attempt', 'channel.outcome', 'channel.preflight.outcome',
    'client.activity', 'computer.receipt.linked'].includes(event)) return 'memory.tool-call';
  return 'memory.save';
}
