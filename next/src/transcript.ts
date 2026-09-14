import {
  canonicalJson, contentHash, signerOf, snapshotJson, streamFor,
  type JsonObject, type RappFrame,
} from './canonical.js';
import { label, list, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { publicationData } from './ai-contract.js';
import type { RootSnapshot, StoreSnapshot } from './repository.js';
import { foldState, permittedScopes } from './state.js';
import { memoryFrames, sourceReference } from './source-memory.js';
import { assertCanonicalSelection } from './canonical-forks.js';
import { publicWorkText, reference } from './projection.js';
import { turnAttribution } from './channel-contract.js';

const COLLABORATION_SCHEMA = 'rapp-work.next/collaboration/1';
export const TRANSCRIPT_SCHEMA = 'rapp-work.transcript-page/1';
export const TRANSCRIPT_LIMITS = Object.freeze({ default: 64, context: 32, ai: 16, maximum: 256 });

export interface PublicPerspective extends JsonObject {
  summary: string;
  disagreements: string[];
  unknowns: string[];
}

export interface TranscriptActor extends JsonObject {
  id: string;
  name: string;
  provider: string;
}

export interface TranscriptTurn extends JsonObject {
  role: 'user' | 'assistant';
  speaker: string;
  actor: TranscriptActor;
  text: string;
  source: JsonObject;
  origin: JsonObject;
  replyTo: string | null;
  attribution: JsonObject;
}

export interface TranscriptPage extends JsonObject {
  schema: typeof TRANSCRIPT_SCHEMA;
  root: string;
  scope: string;
  total: number;
  offset: number;
  limit: number;
  returned: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  previousOffset: number | null;
  nextOffset: number | null;
  revision: string;
  turns: TranscriptTurn[];
}

export interface TranscriptOptions {
  offset?: number;
  limit?: number;
  allowIncompleteHistory?: boolean;
  includeCollaboration?: boolean;
}

export function publicPerspective(value: unknown): PublicPerspective {
  const p = object(value, ['summary', 'disagreements', 'unknowns']);
  return {
    summary: text(p.summary, 3_000),
    disagreements: list(p.disagreements, 8).map(v => text(v, 700)),
    unknowns: list(p.unknowns, 8).map(v => text(v, 700)),
  };
}

export function peerGrant(root: RootSnapshot, peer: string): RappFrame | undefined {
  const grant = memoryFrames(root).filter(f =>
    f.payload.event === 'collaboration.granted' && workEvent(f.payload).data.peer === peer).at(-1);
  return grant && workEvent(grant.payload).data.mode === 'allow' ? grant : undefined;
}

export function assertCollaborationRequest(frame: RappFrame): JsonObject {
  const p = object(frame.payload,
    ['schema', 'root', 'to', 'operationId', 'question', 'callerGrant', 'recipientGrant'],
    ['briefRef', 'publicBrief']);
  requireThat(p.schema === COLLABORATION_SCHEMA && frame.kind === 'swarm.guidance',
    'collaboration', 'A signed canonical guidance request is required.');
  requireThat(frame.stream_id === streamFor(String(p.root), 'swarm') && signerOf(frame) === p.root,
    'collaboration-binding', 'The public request must speak as its original signed root.');
  label(p.operationId);
  text(p.question, 2_000);
  requireThat((p.briefRef !== undefined) !== (p.publicBrief !== undefined),
    'collaboration-binding', 'A request retains exactly one original brief reference or immutable legacy brief.');
  if (p.briefRef !== undefined) object(p.briefRef);
  else text(p.publicBrief, 2_000);
  return p;
}

function findRoot(snapshot: StoreSnapshot, root: string): RootSnapshot {
  const selected = snapshot.roots.find(candidate => candidate.definition.root === root);
  requireThat(selected, 'root-not-found', 'Choose an existing canonical root.');
  return selected;
}

function actorForRoot(snapshot: StoreSnapshot, root: string): TranscriptActor {
  const selected = findRoot(snapshot, root);
  return { id: root, name: selected.definition.name, provider: 'canonical-core' };
}

function orderedSelection(snapshot: StoreSnapshot, own: RootSnapshot,
  hashes: ReadonlySet<string>): readonly RappFrame[] {
  const chains = [memoryFrames(own), ...snapshot.roots.map(root => root.streams.swarm)]
    .map(chain => chain.filter(frame => hashes.has(frame.frame_hash))).filter(chain => chain.length);
  const positions = chains.map(() => 0);
  const selected: RappFrame[] = [];
  while (selected.length < hashes.size) {
    const ready = chains.map((chain, index) => ({ frame: chain[positions[index]!], index }))
      .filter((item): item is { frame: RappFrame; index: number } => item.frame !== undefined)
      .sort((left, right) => left.frame.utc.localeCompare(right.frame.utc)
        || left.frame.frame_hash.localeCompare(right.frame.frame_hash));
    requireThat(ready.length > 0, 'stale-projection',
      'A selected canonical transcript occurrence is no longer available.');
    const next = ready[0]!;
    selected.push(next.frame);
    positions[next.index] = positions[next.index]! + 1;
  }
  requireThat(selected.length === hashes.size, 'stale-projection',
    'A selected canonical transcript occurrence is no longer available.');
  return selected;
}

export function verifiedTranscript(snapshot: StoreSnapshot, root: string, scope = 'root',
  options: TranscriptOptions = {}): TranscriptTurn[] {
  const own = findRoot(snapshot, root);
  assertCanonicalSelection(own);
  const allowed = permittedScopes(foldState(own).scopes, scope);
  const includeCollaboration = options.includeCollaboration !== false;
  const candidates = includeCollaboration && allowed.has('root') ? snapshot.roots.flatMap(candidate => candidate.streams.swarm).filter(frame =>
    frame.kind === 'swarm.guidance' && (frame.payload.root === root || frame.payload.to === root)) : [];
  const requests: RappFrame[] = [];
  const authorized = new Map<string, JsonObject>();
  for (const request of candidates) {
    const data = assertCollaborationRequest(request);
    const caller = snapshot.roots.find(candidate => candidate.definition.root === data.root);
    const recipient = snapshot.roots.find(candidate => candidate.definition.root === data.to);
    requireThat(caller && recipient, 'collaboration-binding',
      'A public request must retain both original root identities.');
    assertCanonicalSelection(caller);
    assertCanonicalSelection(recipient);
    const callerGrant = memoryFrames(caller).find(frame => frame.frame_hash === data.callerGrant);
    const recipientGrant = memoryFrames(recipient).find(frame => frame.frame_hash === data.recipientGrant);
    if ((!callerGrant || !recipientGrant) && options.allowIncompleteHistory) continue;
    requireThat(callerGrant?.payload.event === 'collaboration.granted'
      && recipientGrant?.payload.event === 'collaboration.granted'
      && workEvent(callerGrant.payload).data.mode === 'allow'
      && workEvent(recipientGrant.payload).data.mode === 'allow'
      && workEvent(callerGrant.payload).data.peer === data.to
      && workEvent(recipientGrant.payload).data.peer === data.root
      && (data.briefRef !== undefined
        ? canonicalJson(data.briefRef) === canonicalJson(sourceReference(callerGrant))
        : workEvent(callerGrant.payload).data.publicBrief === data.publicBrief),
    'collaboration-binding', 'A public request must retain both exact historical consent frames.');
    requests.push(request);
    authorized.set(request.frame_hash, data);
  }
  const echoes = allowed.has('root') ? snapshot.roots.flatMap(candidate => candidate.streams.swarm).filter(frame => {
    if (frame.kind !== 'swarm.echo') return false;
    const request = requests.find(candidate => candidate.frame_hash === frame.payload.requestWave);
    if (!request) return false;
    object(frame.payload,
      ['schema', 'root', 'to', 'requestWave', 'requestParticle', 'recipientGrant', 'public', 'status', 'operationId']);
    requireThat(frame.payload.root === request.payload.to && frame.payload.to === request.payload.root
      && frame.payload.requestParticle === request.payload_hash
      && frame.payload.recipientGrant === request.payload.recipientGrant
      && signerOf(frame) === frame.payload.root && frame.payload.schema === COLLABORATION_SCHEMA
      && frame.payload.operationId === `echo-${request.frame_hash}`
      && (frame.payload.status === 'completed' || frame.payload.status === 'unavailable'),
    'collaboration-binding', 'A public echo must bind the exact signed request, recipient and grant.');
    publicPerspective(frame.payload.public);
    return true;
  }) : [];
  const syntheses = memoryFrames(own).filter(frame =>
    frame.payload.event === 'collaboration.synthesized'
      && allowed.has(String(frame.payload.scope))
      && (!includeCollaboration || authorized.has(String(workEvent(frame.payload).data.requestWave))));
  const ordinary = memoryFrames(own).filter(frame =>
    allowed.has(String(frame.payload.scope))
      && ['turn.user', 'turn.assistant', 'client.conversation'].includes(String(frame.payload.event)));
  const selected = orderedSelection(snapshot, own,
    new Set([...requests, ...echoes, ...syntheses, ...ordinary].map(frame => frame.frame_hash)));
  return selected.map(frame => {
    const memory = frame.kind.startsWith('memory.');
    const event = memory ? workEvent(frame.payload) : null;
    const data = event ? event.data : frame.payload;
    if (includeCollaboration && event?.event === 'collaboration.synthesized') {
      const original = echoes.find(candidate => candidate.frame_hash === data.responseWave);
      const request = authorized.get(String(data.requestWave));
      requireThat(original && request?.root === own.definition.root
        && original.payload.requestWave === data.requestWave
        && data.consensus === false && data.actions === 'review-required',
      'collaboration-binding', 'A caller synthesis must bind this exact request/response pair without action authority.');
      publicPerspective(data.public);
      if (data.format !== undefined) {
        requireThat(data.format === 'rapp-work.synthesis-references/1'
          && canonicalJson(sourceReference(original)) === canonicalJson(data.responseRef),
        'collaboration-binding', 'A synthesis must retain its peer’s exact original source.');
      }
    }
    const role = event?.event === 'turn.user' ? 'user' : 'assistant';
    const client = event?.event === 'client.conversation' ? publicationData('conversation', data) : null;
    const actor = client ? client.actor
      : data.origin === 'external-imessage'
        ? { id: 'external-imessage', name: 'External iMessage participant', provider: 'external-imessage' }
        : role === 'user'
          ? { id: 'human', name: 'Human', provider: 'local-operator' }
          : actorForRoot(snapshot, String(frame.payload.root));
    const publicText = frame.kind === 'swarm.guidance' ? String(data.question)
      : frame.kind === 'swarm.echo' ? (() => {
        const perspective = publicPerspective(data.public);
        return [perspective.summary,
          ...perspective.disagreements.map(disagreement => `Disagreement: ${disagreement}`),
          ...perspective.unknowns.map(unknown => `Unknown: ${unknown}`)].join('\n');
      })()
        : client ? String(client.content.text)
          : publicWorkText(frame);
    return {
      role, speaker: role === 'user' ? 'human' : String(frame.payload.root),
      actor, text: publicText, source: reference(frame), origin: sourceReference(frame),
      attribution: memory ? turnAttribution(frame) : { origin: 'canonical-collaboration', approvalAuthority: false },
      replyTo: typeof data.requestWave === 'string'
        ? data.requestWave : typeof data.replyTo === 'string' ? data.replyTo : null,
    } as TranscriptTurn;
  });
}

export function pageTranscript(turns: readonly TranscriptTurn[], root: string, scope = 'root',
  options: TranscriptOptions = {}): TranscriptPage {
  const limit = options.limit ?? TRANSCRIPT_LIMITS.default;
  requireThat(Number.isInteger(limit) && limit >= 1 && limit <= TRANSCRIPT_LIMITS.maximum,
    'transcript-page', `Transcript pages contain 1–${TRANSCRIPT_LIMITS.maximum} turns.`);
  const defaultOffset = Math.max(0, turns.length - limit);
  const offset = options.offset ?? defaultOffset;
  requireThat(Number.isInteger(offset) && offset >= 0 && offset <= turns.length,
    'transcript-page', 'Transcript offset must identify a retained turn boundary.');
  const pageTurns = turns.slice(offset, offset + limit);
  const truncatedBefore = offset > 0;
  const truncatedAfter = offset + pageTurns.length < turns.length;
  const page: TranscriptPage = {
    schema: TRANSCRIPT_SCHEMA, root, scope, total: turns.length, offset, limit,
    returned: pageTurns.length, truncatedBefore, truncatedAfter,
    previousOffset: truncatedBefore ? Math.max(0, offset - limit) : null,
    nextOffset: truncatedAfter ? offset + pageTurns.length : null,
    revision: contentHash({ root, scope, turns: turns.map(turn => turn.source.frame_hash) }),
    turns: [...pageTurns],
  };
  return snapshotJson(page) as TranscriptPage;
}

export function projectTranscript(snapshot: StoreSnapshot, root: string, scope = 'root',
  options: TranscriptOptions = {}): TranscriptPage {
  return pageTranscript(verifiedTranscript(snapshot, root, scope, options), root, scope, options);
}

export function transcriptMetadata(page: TranscriptPage): JsonObject {
  const { turns: _turns, ...metadata } = page;
  return metadata;
}
