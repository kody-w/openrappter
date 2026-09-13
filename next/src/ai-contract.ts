import { isBodyStream, isUtc, type JsonObject, type JsonValue } from './canonical.js';
import { label, list, object, text } from './contract.js';
import { requireThat } from './errors.js';
import { wave } from './intent.js';

export const AI_PROJECTION_SCHEMA = 'rapp-work.ai-projection/1';
export const VIEW_SCHEMA = 'rapp-work.view-intent/1';
export const AI_LIMITS = Object.freeze({
  requestBytes: 32_768, snapshotBytes: 262_144, publicationsPerMinute: 60,
  clientsPerRoot: 32, viewHeads: 16, subscriptions: 16, queuedEvents: 8, queuedBytes: 524_288,
  replayEvents: 32, pageEvents: 16, windowItems: 16, subscriptionMs: 300_000,
  outputBytes: 1_048_576, requestsPerMinute: 120, pollMs: 250,
});
export const AI_RIGHTS = Object.freeze([
  'projection.read', 'projection.subscribe', 'conversation.publish', 'activity.publish',
  'evidence.publish', 'attention.publish', 'view.publish', 'view.resolve',
] as const);
export type AiRight = typeof AI_RIGHTS[number];
export type PublicationKind = 'conversation' | 'activity' | 'evidence' | 'attention' | 'view';

export interface ClientActor extends JsonObject {
  id: string;
  name: string;
  provider: string;
  grantWave: string;
}
export interface ClientGrant extends JsonObject {
  client: string;
  name: string;
  provider: string;
  scope: string;
  rights: AiRight[];
  tokenHash: string;
  issuedUtc: string;
  expiresUtc: string;
  ttlSeconds: number;
}
export function grantData(value: unknown): ClientGrant {
  const g = object(value, ['client', 'name', 'provider', 'scope', 'rights', 'tokenHash', 'issuedUtc', 'expiresUtc', 'ttlSeconds']);
  requireThat(isBodyStream(g.client), 'client-identity', 'A canonical client attribution identity is required.');
  text(g.name, 80); label(g.provider); label(g.scope); wave(g.tokenHash);
  const rights = list(g.rights, AI_RIGHTS.length).map(r => text(r, 40));
  requireThat(rights.length > 0 && new Set(rights).size === rights.length
    && rights.every(r => (AI_RIGHTS as readonly string[]).includes(r)), 'client-rights', 'Only explicit closed publication/read rights are supported.');
  requireThat(isUtc(g.issuedUtc) && isUtc(g.expiresUtc) && g.expiresUtc > g.issuedUtc
    && Number.isInteger(g.ttlSeconds) && Number(g.ttlSeconds) >= 1 && Number(g.ttlSeconds) <= 86_400
    && Date.parse(g.expiresUtc) - Date.parse(g.issuedUtc) === Number(g.ttlSeconds) * 1_000,
  'client-expiry', 'A bounded, exact credential lifetime is required.');
  return g as ClientGrant;
}

export interface CardReference extends JsonObject {
  kind: 'artifact' | 'evidence' | 'activity' | 'attention' | 'routine';
  ref: string;
}
export interface ViewIntent extends JsonObject {
  schema: typeof VIEW_SCHEMA;
  focus: string;
  emphasis: 'conversation' | 'work' | 'evidence' | 'review';
  cards: CardReference[];
  progress: string | null;
  screenArtifact: string | null;
}
export function viewIntent(value: unknown): ViewIntent {
  const v = object(value, ['schema', 'focus', 'emphasis', 'cards', 'progress', 'screenArtifact']);
  requireThat(v.schema === VIEW_SCHEMA && ['conversation', 'work', 'evidence', 'review'].includes(String(v.emphasis)),
    'view-contract', 'Only the closed declarative emphasis vocabulary is supported.');
  label(v.focus);
  const cards = list(v.cards, 8).map(value => {
    const c = object(value, ['kind', 'ref']);
    requireThat(['artifact', 'evidence', 'activity', 'attention', 'routine'].includes(String(c.kind)),
      'view-contract', 'Cards reference canonical artifacts, evidence, activity, attention or routines only.');
    if (c.kind === 'artifact' || c.kind === 'routine') label(c.ref);
    else wave(c.ref);
    return c as CardReference;
  });
  if (v.progress !== null) wave(v.progress);
  if (v.screenArtifact !== null) label(v.screenArtifact);
  requireThat(new Set(cards.map(c => `${c.kind}:${c.ref}`)).size === cards.length, 'view-contract', 'Duplicate visible cards are refused.');
  return { ...v, cards } as ViewIntent;
}

export function publicationContent(kind: PublicationKind, value: unknown): JsonObject {
  if (kind === 'conversation') {
    const c = object(value, ['text']);
    return { text: text(c.text, 2_000) };
  }
  if (kind === 'activity') {
    const c = object(value, ['summary', 'status', 'completed', 'total', 'evidence']);
    requireThat(['working', 'blocked', 'review', 'complete', 'idle'].includes(String(c.status)),
      'activity-contract', 'Use a bounded public activity status, not a UI command.');
    requireThat(Number.isSafeInteger(c.completed) && Number.isSafeInteger(c.total)
      && Number(c.completed) >= 0 && Number(c.total) >= 0 && Number(c.total) <= 1_000_000
      && Number(c.completed) <= Number(c.total), 'activity-contract', 'Progress must be bounded exact integers.');
    return { ...c, summary: text(c.summary, 1_000), evidence: hashes(c.evidence, 8) };
  }
  if (kind === 'evidence') {
    const c = object(value, ['summary', 'references']);
    const references = hashes(c.references, 8);
    requireThat(references.length > 0, 'evidence-contract', 'Evidence must identify canonical source occurrences.');
    return { summary: text(c.summary, 1_000), references };
  }
  if (kind === 'attention') {
    const c = object(value, ['summary', 'reason', 'references']);
    requireThat(['human-authority', 'irreducible-ambiguity', 'blocked', 'decision'].includes(String(c.reason)),
      'attention-contract', 'Attention is a public decision/blocker summary, never a privilege grant.');
    return { summary: text(c.summary, 1_000), reason: c.reason!, references: hashes(c.references, 8) };
  }
  requireThat(kind === 'view', 'publication-kind', 'Unsupported publication kind.');
  return object(value, []);
}

export function publicationKind(value: unknown): PublicationKind {
  requireThat(['conversation', 'activity', 'evidence', 'attention', 'view'].includes(String(value)),
    'publication-kind', 'Only public conversation/activity/evidence/attention and declarative view intents may be published.');
  return value as PublicationKind;
}
export function hashes(value: JsonValue | undefined, max = 16): string[] {
  const items = list(value, max).map(wave);
  requireThat(new Set(items).size === items.length, 'causality', 'Canonical references must be unique.');
  return items;
}
export function publicationRight(kind: PublicationKind): AiRight {
  return `${kind}.publish` as AiRight;
}

export interface PublicationData extends JsonObject {
  actor: ClientActor;
  requestHash: string;
  content: JsonObject;
  causes: string[];
  view: ViewIntent | null;
  viewParents: string[];
  viewRefusal: JsonObject | null;
}
export function publicationData(kind: PublicationKind, value: unknown): PublicationData {
  const p = object(value, ['actor', 'requestHash', 'content', 'causes', 'view', 'viewParents', 'viewRefusal']);
  const actor = object(p.actor, ['id', 'name', 'provider', 'grantWave']);
  requireThat(isBodyStream(actor.id), 'client-identity', 'Invalid attributed client identity.');
  text(actor.name, 80); label(actor.provider); wave(actor.grantWave); wave(p.requestHash);
  if (p.viewRefusal !== null) {
    const refusal = object(p.viewRefusal, ['code', 'message']);
    requireThat(refusal.code === 'view-hint-refused' && typeof refusal.message === 'string'
      && refusal.message.length <= 160, 'view-contract', 'Only a bounded public refusal diagnostic is stored.');
  }
  return {
    actor: actor as ClientActor, requestHash: String(p.requestHash),
    content: publicationContent(kind, p.content), causes: hashes(p.causes),
    view: p.view === null ? null : viewIntent(p.view), viewParents: hashes(p.viewParents, 8),
    viewRefusal: p.viewRefusal as JsonObject | null,
  };
}
