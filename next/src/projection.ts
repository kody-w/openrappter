import { AUTHORITY, frameHead, snapshotJson, type JsonObject, type RappFrame } from './canonical.js';
import { PROJECTION_SCHEMA, object, text, workEvent, type Scope } from './contract.js';
import type { RootSnapshot } from './repository.js';
import { requireThat } from './errors.js';
import { foldState } from './state.js';
import { publicationData } from './ai-contract.js';

export interface PublicTurn extends JsonObject {
  role: 'user' | 'assistant';
  speaker: string;
  text: string;
  source: JsonObject;
  replyTo: string | null;
}
export interface Attention extends JsonObject { kind: string; summary: string; source: string }
export interface BotProjection extends JsonObject {
  schema: typeof PROJECTION_SCHEMA;
  root: string;
  name: string;
  hidden: boolean;
  authority: JsonObject;
  scopes: Scope[];
  turns: PublicTurn[];
  outcomes: JsonObject[];
  attention: Attention[];
  heads: JsonObject;
  branches: JsonObject[];
  proposals: JsonObject[];
  routines: JsonObject[];
  pointers: JsonObject[];
  artifacts: JsonObject[];
  progress: JsonObject[];
}
export const reference = (frame: RappFrame): JsonObject => snapshotJson(frameHead(frame)) as JsonObject;

export function projectBot(root: RootSnapshot): BotProjection {
  const state = foldState(root);
  const result: BotProjection = {
    schema: PROJECTION_SCHEMA, root: root.definition.root, name: root.definition.name, hidden: false,
    authority: { ...AUTHORITY, integrity: 'verified', factualTruth: false, externalAdoption: false },
    scopes: state.scopes, turns: [], outcomes: [], attention: [],
    heads: Object.fromEntries(Object.entries(root.streams).map(([family, frames]) =>
      [family, frames.length ? reference(frames.at(-1)!) : null])),
    branches: root.branches.map(b => ({ family: b.family, head: b.head, frames: b.frames.length, selected: false })),
    proposals: [...state.proposals].map(([wave, p]) => ({ wave, draft: p.draft, status: p.status })),
    routines: [...state.routines.values()], pointers: [...state.pointers.values()],
    artifacts: [...state.artifacts.values()], progress: state.progress,
  };
  const settled = new Set<string>();
  for (const frame of root.streams.memory) {
    const event = workEvent(frame.payload);
    const data = event.data;
    if (event.event === 'root.visibility') {
      object(data, ['hidden']);
      requireThat(typeof data.hidden === 'boolean', 'contract', 'Visibility is hide/restore, never deletion.');
      result.hidden = data.hidden;
    } else if (event.event === 'turn.user' || event.event === 'turn.assistant' || event.event === 'collaboration.synthesized') {
      const role = event.event === 'turn.user' ? 'user' : 'assistant';
      result.turns.push({ role, speaker: role === 'user' ? 'human' : root.definition.root,
        text: text(data.text), source: reference(frame), replyTo: typeof data.replyTo === 'string' ? data.replyTo : null });
      if (typeof data.replyTo === 'string') settled.add(data.replyTo);
    } else if (event.event === 'client.conversation') {
      const p = publicationData('conversation', data);
      result.turns.push({ role: 'assistant', speaker: root.definition.root,
        text: `[${p.actor.name} / ${p.actor.provider}] ${String(p.content.text)}`, source: reference(frame), replyTo: null });
    } else {
      result.outcomes.push({ event: event.event, scope: event.scope, data, source: reference(frame), corrected: state.corrected.has(frame.frame_hash) });
      if (typeof data.replyTo === 'string') settled.add(data.replyTo);
      if (event.event === 'provider.unavailable' || event.event === 'operation.interrupted') {
        result.attention.push({ kind: event.event, summary: String(data.summary), source: frame.frame_hash });
      }
    }
  }
  for (const turn of result.turns) {
    if (turn.role === 'user' && !settled.has(String(turn.source.frame_hash))) {
      result.attention.push({ kind: 'incomplete-turn', summary: 'A recorded thought has no completed response. It will not be replayed automatically.',
        source: String(turn.source.frame_hash) });
    }
  }
  if (root.branches.length) result.attention.push({
    kind: 'preserved-branches', summary: 'Alternative canonical branches are retained, not merged into this perspective.',
    source: root.branches[0]!.head,
  });
  for (const [hash, proposal] of state.proposals) {
    if (proposal.status === 'review' && (proposal.draft.actions.length || proposal.draft.questions.length || proposal.draft.resolves.length)) {
      result.attention.push({ kind: proposal.draft.questions.length ? 'human-question' : 'review-required',
        summary: proposal.draft.questions.length ? proposal.draft.questions.map(q => q.question).join(' ') : proposal.draft.summary, source: hash });
    }
  }
  for (const frame of root.streams.memory) {
    const e = workEvent(frame.payload);
    if (e.event === 'effect.approved' && !root.streams.memory.some(f => f.payload.event === 'effect.outcome'
      && workEvent(f.payload).data.approval === frame.frame_hash)) {
      result.attention.push({ kind: 'external-uncertain', summary: 'An approved external action has no outcome. Do not replay it automatically.', source: frame.frame_hash });
    }
    if (e.event === 'effect.outcome' && e.data.status !== 'completed') {
      result.attention.push({ kind: e.data.status === 'uncertain' ? 'external-uncertain' : 'external-unavailable',
        summary: 'An explicitly approved external action is unavailable or uncertain; no automatic retry is authorized.', source: frame.frame_hash });
    }
    if (e.event === 'channel.queued' && !root.streams.memory.some(f => f.payload.event === 'channel.outcome'
      && workEvent(f.payload).data.deliveryId === frame.frame_hash && workEvent(f.payload).data.status === 'delivered')) {
      result.attention.push({ kind: 'channel-pending', summary: 'A private-channel recap is pending; an explicit retry may be needed.', source: frame.frame_hash });
    }
  }
  for (const request of root.streams.swarm.filter(f => f.kind === 'swarm.guidance')) {
    if (!root.streams.memory.some(f => f.payload.event === 'collaboration.perspective'
      && workEvent(f.payload).data.requestWave === request.frame_hash)) {
      result.attention.push({ kind: 'collaboration-pending', summary: 'A signed public request has no recorded response link; restart will not replay it.', source: request.frame_hash });
    }
  }
  return snapshotJson(result) as BotProjection;
}

export function orient(projection: BotProjection): { text: string; evidence: JsonObject[] } {
  const last = projection.turns.at(-1);
  const outcome = projection.outcomes.at(-1);
  const lines = [`We are in ${projection.name}, the same root ${projection.root}.`];
  if (projection.hidden) lines.push('This bot is hidden; restoring it preserves its GUID and history.');
  if (last) lines.push(`Last public turn: ${last.text}`);
  else lines.push('The canonical world is ready; no conversation has been recorded yet.');
  if (outcome) lines.push(`Latest recorded outcome: ${String(outcome.event)}.`);
  if (projection.progress.length) lines.push(`Progress: ${String(projection.progress.at(-1)!.summary)}`);
  if (projection.routines.length) lines.push(`Reviewed recurring work: ${projection.routines.map(r => String(r.instruction)).join('; ')} (Monday 09:00 UTC).`);
  if (projection.attention.length) lines.push(`Needs attention: ${projection.attention.map(a => a.summary).join(' ')}`);
  else lines.push('There are no unresolved recorded decisions.');
  return { text: lines.join('\n'), evidence: [
    ...(last ? [last.source] : []), ...(outcome ? [outcome.source as JsonObject] : []),
  ] };
}
