import { AUTHORITY, frameHead, snapshotJson, type JsonObject, type RappFrame } from './canonical.js';
import { PROJECTION_SCHEMA, object, text, validateTree, workEvent, type Scope } from './contract.js';
import type { RootSnapshot } from './repository.js';
import { requireThat } from './errors.js';

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
}
export const reference = (frame: RappFrame): JsonObject => snapshotJson(frameHead(frame)) as JsonObject;

export function projectBot(root: RootSnapshot): BotProjection {
  const result: BotProjection = {
    schema: PROJECTION_SCHEMA, root: root.definition.root, name: root.definition.name, hidden: false,
    authority: { ...AUTHORITY, integrity: 'verified', factualTruth: false, externalAdoption: false },
    scopes: root.definition.scopes.map(s => ({ ...s })), turns: [], outcomes: [], attention: [],
    heads: Object.fromEntries(Object.entries(root.streams).map(([family, frames]) =>
      [family, frames.length ? reference(frames.at(-1)!) : null])),
    branches: root.branches.map(b => ({ family: b.family, head: b.head, frames: b.frames.length, selected: false })),
  };
  const settled = new Set<string>();
  for (const frame of root.streams.memory) {
    const event = workEvent(frame.payload);
    requireThat(result.scopes.some(s => s.id === event.scope), 'scope-isolation', 'An event references an unknown internal scope.');
    const data = event.data;
    if (event.event === 'root.visibility') {
      object(data, ['hidden']);
      requireThat(typeof data.hidden === 'boolean', 'contract', 'Visibility is hide/restore, never deletion.');
      result.hidden = data.hidden;
    } else if (event.event === 'turn.user' || event.event === 'turn.assistant') {
      const role = event.event === 'turn.user' ? 'user' : 'assistant';
      result.turns.push({ role, speaker: role === 'user' ? 'human' : root.definition.root,
        text: text(data.text), source: reference(frame), replyTo: typeof data.replyTo === 'string' ? data.replyTo : null });
      if (typeof data.replyTo === 'string') settled.add(data.replyTo);
    } else {
      result.outcomes.push({ event: event.event, scope: event.scope, data, source: reference(frame) });
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
  validateTree(result.scopes);
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
  if (projection.attention.length) lines.push(`Needs attention: ${projection.attention.map(a => a.summary).join(' ')}`);
  else lines.push('There are no unresolved recorded decisions.');
  return { text: lines.join('\n'), evidence: [
    ...(last ? [last.source] : []), ...(outcome ? [outcome.source as JsonObject] : []),
  ] };
}
