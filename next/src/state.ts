import { contentHash, type JsonObject, type RappFrame } from './canonical.js';
import { label, list, object, text, validateTree, workEvent, type Scope } from './contract.js';
import { requireThat } from './errors.js';
import { validateDraft, wave, type Draft, type IntentAction, type RoutineAction } from './intent.js';
import type { RootSnapshot } from './repository.js';
import { migrationItem } from './migration-contract.js';
import { memoryFrames, sourceReference, scopeCreationOwners } from './source-memory.js';
import { discoveryEvidence } from './estate-contract.js';
import { assertCanonicalSelection } from './canonical-forks.js';

export interface InternalState {
  scopes: Scope[];
  proposals: Map<string, { draft: Draft; frame: RappFrame; status: 'review' | 'applied' | 'corrected' | 'superseded' }>;
  routines: Map<string, RoutineAction & { source: string }>;
  pointers: Map<string, JsonObject>;
  artifacts: Map<string, JsonObject>;
  effects: Map<string, JsonObject>;
  progress: JsonObject[];
  corrected: Set<string>;
  ticked: Set<string>;
}

export function foldState(root: RootSnapshot, extraCorrections: readonly string[] = []): InternalState {
  assertCanonicalSelection(root);
  const corrected = new Set(extraCorrections);
  const memory = memoryFrames(root);
  const byWave = new Map(memory.map(f => [f.frame_hash, f]));
  const positions = new Map(memory.map((f, i) => [f.frame_hash, i]));
  for (const frame of memory) {
    const e = workEvent(frame.payload);
    if (e.event === 'state.corrected') {
      object(e.data, ['targetWave', 'reason']);
      const target = byWave.get(wave(e.data.targetWave));
      requireThat(target && positions.get(target.frame_hash)! < positions.get(frame.frame_hash)! && ['organization.applied', 'work.progress', 'routine.tick'].includes(String(target.payload.event)),
        'correction', 'Only prior reversible internal outcomes can be corrected.');
      requireThat(target.payload.scope === e.scope || (target.stream_id.endsWith(':work') && frame.stream_id.endsWith(':work')),
        'source-ownership', 'A new correction must be owned by the same exact source scope as its original outcome.');
      requireThat(!corrected.has(target.frame_hash), 'correction', 'An outcome has already been corrected.');
      text(e.data.reason, 1_000);
      corrected.add(target.frame_hash);
    }
  }
  const state: InternalState = {
    scopes: root.definition.scopes.map(s => ({ ...s })), proposals: new Map(), routines: new Map(),
    pointers: new Map(), artifacts: new Map(), effects: new Map(), progress: [], corrected, ticked: new Set(),
  };
  for (const [position, frame] of memory.entries()) {
    const e = workEvent(frame.payload);
    requireThat(state.scopes.some(s => s.id === e.scope), 'scope-dependency',
      'An outcome has a dependent scope; correction may not orphan canonical work.');
    const data = e.data;
    if (e.event === 'turn.assistant' && data.draft !== undefined) {
      state.proposals.set(frame.frame_hash, { draft: validateDraft(data.draft), frame, status: 'review' });
    }
    if (e.event === 'organization.applied') {
      object(data, ['proposalWave', 'summary', 'actor']);
      requireThat(data.actor === 'local-operator' || data.actor === 'bound-private-contact', 'approval', 'Explicit human confirmation is required.');
      const proposal = state.proposals.get(wave(data.proposalWave));
      requireThat(proposal && proposal.status === 'review', 'proposal', 'A reviewed proposal is required exactly once.');
      requireThat(proposal.draft.questions.length === 0, 'human-question', 'Resolve the irreducible human question before applying work.');
      proposal.status = corrected.has(frame.frame_hash) ? 'corrected' : 'applied';
      if (corrected.has(frame.frame_hash)) continue;
      validateResolutions(state, proposal.draft, e.scope);
      if (proposal.draft.resolves.some(hash => workEvent(state.proposals.get(hash)!.frame.payload).data.clarify !== undefined)) {
        const input = byWave.get(String(workEvent(proposal.frame.payload).data.replyTo));
        requireThat(data.actor === 'local-operator' && input?.payload.event === 'turn.user'
          && input.payload.scope === e.scope && workEvent(input.payload).data.origin === 'copilot-cli',
        'confirmation-origin', 'Canonical clarification settlement requires the genuine CLI source of the confirmed resolution, never external inbox data.');
      }
      for (const resolved of proposal.draft.resolves) state.proposals.get(resolved)!.status = 'superseded';
      applyScopedActions(state, proposal.draft.actions, root, frame.frame_hash, e.scope);
    } else if (e.event === 'work.progress' && !corrected.has(frame.frame_hash)) {
      object(data, ['summary', 'evidence']);
      text(data.summary, 2_000);
      validateEvidence(data.evidence, root, position);
      state.progress.push({ scope: e.scope, summary: text(data.summary, 2_000), evidence: data.evidence!, source: frame.frame_hash, origin: sourceReference(frame) });
    } else if (e.event === 'routine.tick') {
      object(data, ['routineId', 'occurrence', 'summary', 'evidence']);
      const routine = state.routines.get(label(data.routineId));
      requireThat(routine && (routine.scope === e.scope || frame.stream_id.endsWith(':work')), 'routine', 'A tick requires a reviewed active routine in its original source scope.');
      const occurrence = text(data.occurrence, 32);
      requireThat(!state.ticked.has(`${routine.id}:${occurrence}`), 'idempotency', 'A routine occurrence was already recorded.');
      state.ticked.add(`${routine.id}:${occurrence}`);
      validateEvidence(data.evidence, root, position);
      if (!corrected.has(frame.frame_hash)) {
        state.progress.push({ scope: routine.scope, summary: text(data.summary, 2_000), evidence: data.evidence!, source: frame.frame_hash, origin: sourceReference(frame) });
      }
    } else if (e.event === 'migration.pointer.imported') {
      object(data, ['planHash', 'batch', 'item', 'source', 'approvalWave']);
      const item = migrationItem(data.source);
      requireThat(item.kind === 'estate-pointer' && item.root === root.definition.root && item.id === data.item
        && item.pointer!.scope === e.scope && ![...state.pointers.values()].some(p => p.sourceIdentity === item.sourceIdentity),
      'migration-pointer', 'Imported pointer identities, scopes and provenance must remain exact and unique.');
      state.pointers.set(`migration-${item.id}`, {
        id: item.id, scope: e.scope, source: frame.frame_hash, origin: sourceReference(frame), sourceIdentity: item.sourceIdentity,
        classification: item.classification, provider: item.provider, sourceDigest: item.sourceDigest,
        pointer: { title: item.title, locator: item.sourceLocator, ...item.pointer! },
      });
    }
  }
  validateTree(state.scopes);
  return state;
}

export function validateEvidence(value: unknown, root: RootSnapshot, beforeSeq = Number.MAX_SAFE_INTEGER): string[] {
  const entries = list(value as never, 16).map(wave);
  requireThat(new Set(entries).size === entries.length, 'evidence', 'Evidence references must be unique.');
  const available = new Set([...root.streams.body, ...memoryFrames(root).slice(0, beforeSeq),
    ...root.streams.swarm].map(f => f.frame_hash));
  requireThat(entries.every(hash => available.has(hash)), 'evidence-isolation', 'Evidence must refer to existing canonical frames of this root.');
  return entries;
}

export function validateResolutions(state: InternalState, draft: Draft, scope: string): void {
  for (const hash of draft.resolves) {
    const question = state.proposals.get(hash);
    requireThat(question && question.status === 'review' && question.draft.questions.length > 0
      && question.frame.payload.scope === scope, 'question-resolution',
    'Only an existing unresolved human question in this exact scope can be superseded by a new reviewed answer.');
  }
}

export function applyActions(state: InternalState, actions: readonly IntentAction[], root: RootSnapshot, source: string): void {
  const originalOwners = scopeCreationOwners(root);
  for (const action of actions) {
    const id = action.type === 'scope.create' ? action.scope.id : action.id;
    const parent = action.type === 'scope.create' ? action.scope.parent : action.scope;
    requireThat(!originalOwners.has(id) || originalOwners.get(id) === source, 'scope-identity-reused',
      'A previously created internal scope ID remains reserved after correction. Choose a new scope ID instead of re-rooting its history.');
    requireThat(!state.scopes.some(s => s.id === id) && state.scopes.some(s => s.id === parent), 'scope',
      'An internal organ needs a unique local ID and an existing parent; identities are not merged.');
    if (action.type === 'scope.create') state.scopes.push({ ...action.scope });
    else {
      const kind = action.type === 'routine.create' ? 'routine' : action.type === 'artifact.save' ? 'artifact'
        : action.type === 'pointer.register' ? 'workspace' : 'task';
      state.scopes.push({ id, parent, kind, name: action.type === 'artifact.save' ? action.name : id,
        description: action.type === 'routine.create' ? action.instruction : `Reviewed ${action.type}; canonical source ${source}.` });
    }

    if (action.type === 'routine.create') state.routines.set(id, { ...action, source });
    if (action.type === 'artifact.save') state.artifacts.set(id, { ...action, source, contentHash: contentHash({ content: action.content }) });
    if (action.type === 'external.request') state.effects.set(id, { ...action, source, requestHash: contentHash(action) });
    if (action.type === 'pointer.register') {
      const evidence = memoryFrames(root).find(f => f.frame_hash === action.evidenceWave && f.payload.event === 'discovery.recorded');
      requireThat(evidence, 'discovery-evidence', 'Only this root’s explicitly recorded discovery evidence can establish a pointer.');
      const data = workEvent(evidence.payload).data;
      const captured = discoveryEvidence({ origin: data.origin!, observedUtc: data.observedUtc!, historical: data.historical!, pointers: data.pointers!,
        ...(data.observations === undefined ? {} : { observations: data.observations }) });
      const pointer = captured.pointers.find(p => p.id === action.pointerId);
      requireThat(pointer, 'discovery-evidence', 'The chosen native pointer was not present in the discovery observation.');
      requireThat(![...state.pointers.values()].some(p => {
        const existing = object(p.pointer);
        return existing.provider === pointer.provider && existing.locator === pointer.locator;
      }), 'discovery-duplicate', 'This source context already has a registered pointer; do not mint a duplicate internal workspace.');
      state.pointers.set(id, { ...action, pointer, source });
    }
    validateTree(state.scopes);
  }
}

export function applyScopedActions(state: InternalState, actions: readonly IntentAction[], root: RootSnapshot, source: string, scope: string): void {
  for (const action of actions) {
    const parent = action.type === 'scope.create' ? action.scope.parent : action.scope;
    const permitted = permittedScopes(state.scopes, scope);
    requireThat(parent !== null && permitted.has(parent), 'scope-isolation', 'A proposed action may not escape the selected internal scope.');
    if (action.type === 'pointer.register') {
      const evidence = memoryFrames(root).find(f => f.frame_hash === action.evidenceWave);
      requireThat(evidence && permitted.has(String(evidence.payload.scope)), 'scope-isolation', 'Discovery evidence is outside this request’s permitted scope.');
    }
    applyActions(state, [action], root, source);
  }
}

export function permittedScopes(scopes: readonly Scope[], scope: string): Set<string> {
  requireThat(scopes.some(s => s.id === scope), 'scope', 'Unknown internal scope.');
  const permitted = new Set([scope]);
  let previous = 0;
  while (permitted.size !== previous) {
    previous = permitted.size;
    for (const s of scopes) if (s.parent !== null && permitted.has(s.parent)) permitted.add(s.id);
  }
  return permitted;
}
