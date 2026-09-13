import { isUtc, type JsonObject } from './canonical.js';
import { label, list, object, scope, text, type Scope } from './contract.js';
import { requireThat } from './errors.js';

export interface Action extends JsonObject {
  type: 'scope.create' | 'routine.create' | 'pointer.register' | 'artifact.save' | 'external.request';
}
export interface ScopeAction extends Action { type: 'scope.create'; scope: Scope }
export interface RoutineAction extends Action {
  type: 'routine.create'; id: string; scope: string; instruction: string;
  cadence: 'monday-0900-utc'; firstDueUtc: string; work: 'canonical-recap';
}
export interface PointerAction extends Action {
  type: 'pointer.register'; id: string; scope: string; evidenceWave: string; pointerId: string;
}
export interface ArtifactAction extends Action {
  type: 'artifact.save'; id: string; scope: string; name: string; content: string; mediaType: 'text/plain' | 'text/markdown';
}
export interface ExternalAction extends Action {
  type: 'external.request'; id: string; scope: string; operation: 'send-message'; target: string; content: string;
}
export type IntentAction = ScopeAction | RoutineAction | PointerAction | ArtifactAction | ExternalAction;
export interface Draft extends JsonObject {
  summary: string;
  tradeoffs: string[];
  questions: { reason: 'human-authority' | 'irreducible-ambiguity'; question: string }[];
  actions: IntentAction[];
  resolves: string[];
}

export function wave(value: unknown): string {
  requireThat(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), 'contract', 'An exact canonical wave hash is required.');
  return value;
}

export function nextMonday(after: string): string {
  requireThat(isUtc(after), 'clock', 'Recurring work requires a fixed UTC clock.');
  const date = new Date(after);
  date.setUTCHours(9, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + (8 - date.getUTCDay()) % 7);
  if (date.toISOString() <= after) date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString();
}

export function validateAction(value: unknown, proposalTime?: string): IntentAction {
  const a = object(value);
  if (a.type === 'scope.create') {
    object(a, ['type', 'scope']);
    const s = scope(a.scope);
    requireThat(s.id !== 'root' && s.id !== 'librarian' && s.parent !== null && s.kind !== 'librarian',
      'scope', 'The existing root identity and sole Librarian cannot be recreated.');
    return { type: 'scope.create', scope: s };
  }
  requireThat(['routine.create', 'pointer.register', 'artifact.save', 'external.request'].includes(String(a.type)),
    'unauthorized-action', 'The model cannot expand the tool or provider surface.');
  label(a.id);
  label(a.scope);
  if (a.type === 'routine.create') {
    object(a, ['type', 'id', 'scope', 'instruction', 'cadence', 'work'], ['firstDueUtc']);
    text(a.instruction, 2_000);
    requireThat(a.work === 'canonical-recap', 'routine-authority', 'Recurring work is bounded to reversible canonical recaps, never arbitrary execution.');
    requireThat(a.cadence === 'monday-0900-utc', 'cadence', 'Only the explicitly reviewed Monday 09:00 UTC cadence is available.');
    const firstDueUtc = proposalTime ? nextMonday(proposalTime) : a.firstDueUtc;
    requireThat(isUtc(firstDueUtc) && new Date(firstDueUtc).getUTCDay() === 1
      && firstDueUtc.slice(11) === '09:00:00.000Z', 'cadence', 'The first reviewed occurrence must be Monday 09:00 UTC.');
    if (a.firstDueUtc !== undefined) requireThat(a.firstDueUtc === firstDueUtc, 'cadence', 'The first occurrence differs from the complete reviewed intent.');
    return { ...a, firstDueUtc } as RoutineAction;
  }
  if (a.type === 'pointer.register') {
    object(a, ['type', 'id', 'scope', 'evidenceWave', 'pointerId']);
    wave(a.evidenceWave);
    label(a.pointerId);
    return a as PointerAction;
  }
  if (a.type === 'artifact.save') {
    object(a, ['type', 'id', 'scope', 'name', 'content', 'mediaType']);
    text(a.name, 120);
    requireThat(!/[\\/]/u.test(String(a.name)), 'artifact', 'Artifacts are canonical data, not host paths.');
    text(a.content, 12_000);
    requireThat(a.mediaType === 'text/plain' || a.mediaType === 'text/markdown', 'artifact', 'Only bounded inert text artifacts are supported.');
    return a as ArtifactAction;
  }
  object(a, ['type', 'id', 'scope', 'operation', 'target', 'content']);
  requireThat(a.operation === 'send-message', 'unauthorized-action', 'Only an explicit bounded message request may be proposed.');
  text(a.target, 200);
  text(a.content, 2_000);
  return a as ExternalAction;
}

export function validateDraft(value: unknown, proposalTime?: string): Draft {
  const d = object(value, ['summary', 'tradeoffs', 'questions', 'actions'], ['resolves']);
  const summary = text(d.summary, 2_000);
  requireThat(!/<\/?(?:analysis|thinking|reasoning)>/iu.test(summary), 'private-reasoning',
    'Only public decision summaries may be recorded.');
  const tradeoffs = list(d.tradeoffs, 8).map(v => text(v, 700));
  const questions = list(d.questions, 3).map(v => {
    const q = object(v, ['reason', 'question']);
    requireThat(q.reason === 'human-authority' || q.reason === 'irreducible-ambiguity',
      'question-boundary', 'Only irreducible human or authority questions may interrupt.');
    return { reason: q.reason, question: text(q.question, 700) };
  });
  const actions = list(d.actions, 16).map(v => validateAction(v, proposalTime));
  const resolves = list(d.resolves ?? [], 8).map(wave);
  requireThat(new Set(resolves).size === resolves.length, 'review', 'A human question may be resolved only once per proposal.');
  requireThat((actions.length === 0 && resolves.length === 0) || tradeoffs.length > 0, 'review', 'Material organization tradeoffs must be explained before review.');
  return { summary, tradeoffs, questions, actions, resolves } as Draft;
}
