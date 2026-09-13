import { AUTHORITY, canonicalJson, snapshotJson, type JsonObject, type RappFrame } from './canonical.js';
import { workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { reference } from './projection.js';
import type { RootSnapshot } from './repository.js';
import { foldState, permittedScopes } from './state.js';
import {
  AI_LIMITS, AI_PROJECTION_SCHEMA, grantData, publicationData, publicationKind, publicationRight,
  type ClientGrant, type PublicationData, type PublicationKind, type ViewIntent,
} from './ai-contract.js';

export interface PublishedRecord {
  frame: RappFrame;
  kind: PublicationKind;
  scope: string;
  data: PublicationData;
}

export function publishedRecords(root: RootSnapshot): PublishedRecord[] {
  const grants = new Map<string, { data: ClientGrant; wave: string; active: boolean }>();
  const publications: PublishedRecord[] = [];
  const scopes = foldState(root).scopes;
  const priorViews = new Map<string, PublishedRecord>();
  for (const frame of root.streams.memory) {
    const e = workEvent(frame.payload);
    if (e.event === 'client.granted') {
      const data = grantData(e.data);
      grants.set(data.client, { data, wave: frame.frame_hash, active: true });
    } else if (e.event === 'client.revoked') {
      const grant = grants.get(String(e.data.client));
      requireThat(grant && grant.wave === e.data.grantWave, 'client-authority', 'A client revocation does not match its grant.');
      grant.active = false;
    } else if (e.event.startsWith('client.')) {
      const kind = publicationKind(e.event.slice('client.'.length));
      const data = publicationData(kind, e.data);
      const grant = grants.get(data.actor.id);
      requireThat(grant?.active && grant.wave === data.actor.grantWave && grant.data.name === data.actor.name
        && grant.data.provider === data.actor.provider && grant.data.issuedUtc <= frame.utc && frame.utc < grant.data.expiresUtc
        && grant.data.rights.includes(publicationRight(kind)), 'client-attribution',
      'A publication must bind an active canonical client grant at its occurrence, not a claimed identity.');
      const permitted = permittedScopes(scopes, grant.data.scope);
      requireThat(permitted.has(e.scope), 'client-attribution', 'A signed publication may not exceed its attributed grant scope.');
      if (data.view !== null) {
        const publicationScope = permittedScopes(scopes, e.scope);
        requireThat(grant.data.rights.includes('view.publish'), 'client-attribution', 'View authority is not implicit in conversation authority.');
        requireThat(data.viewParents.every(hash => priorViews.has(hash) && publicationScope.has(priorViews.get(hash)!.scope)
          && (grant.data.rights.includes('view.resolve') || priorViews.get(hash)!.data.actor.id === data.actor.id)),
        'view-causality', 'View history cannot silently consume another client’s unacknowledged intent.');
      }
      const record = { frame, kind, scope: e.scope, data };
      publications.push(record);
      if (data.view !== null) priorViews.set(frame.frame_hash, record);
    }
  }
  return publications;
}

export function scopedFrames(root: RootSnapshot, scope: string): Map<string, RappFrame> {
  const permitted = permittedScopes(foldState(root).scopes, scope);
  const frames = root.streams.memory.filter(f => permitted.has(String(f.payload.scope)));
  if (scope === 'root') frames.push(...root.streams.body, ...root.streams.swarm);
  return new Map(frames.map(f => [f.frame_hash, f]));
}

export function validateViewState(root: RootSnapshot, scope: string, view: ViewIntent): void {
  const state = foldState(root);
  const permitted = permittedScopes(state.scopes, scope);
  const visible = scopedFrames(root, scope);
  requireThat(permitted.has(view.focus), 'view-scope', 'Focus cannot leave the client’s authorized canonical scope.');
  const artifact = (id: string): void => {
    const a = state.artifacts.get(id);
    requireThat(a && permitted.has(String(a.scope)), 'view-reference', 'A visible artifact must exist in this authorized canonical scope.');
  };
  const frame = (id: string, event?: string): void => {
    const f = visible.get(id);
    requireThat(f && (!event || f.payload.event === event)
      && f.payload.event !== 'client.granted' && f.payload.event !== 'client.revoked',
    'view-reference', 'A displayed occurrence must be an authorized canonical work/evidence record.');
  };
  for (const card of view.cards) {
    if (card.kind === 'artifact') artifact(card.ref);
    else if (card.kind === 'routine') {
      const routine = state.routines.get(card.ref);
      requireThat(routine && permitted.has(routine.scope), 'view-reference', 'The selected routine is not available in this scope.');
    } else frame(card.ref, card.kind === 'activity' ? 'client.activity' : card.kind === 'attention' ? 'client.attention' : undefined);
  }
  if (view.progress !== null) frame(view.progress, 'client.activity');
  if (view.screenArtifact !== null) artifact(view.screenArtifact);
}

export function viewFrontier(records: readonly PublishedRecord[]): PublishedRecord[] {
  const heads = new Map<string, PublishedRecord>();
  for (const record of records) {
    if (record.data.view === null) continue;
    for (const parent of record.data.viewParents) heads.delete(parent);
    heads.set(record.frame.frame_hash, record);
  }
  return [...heads.values()];
}

export function cursorFor(root: RootSnapshot): JsonObject | null {
  const frame = root.streams.memory.at(-1);
  return frame ? reference(frame) : null;
}
export function atCursor(root: RootSnapshot, cursor: unknown): RootSnapshot {
  if (cursor === null) return { ...root, streams: { ...root.streams, memory: [] } };
  const candidate = snapshotJson(cursor) as JsonObject;
  const found = root.streams.memory.find(f => canonicalJson(reference(f)) === canonicalJson(candidate));
  requireThat(found, 'cursor-invalid', 'The reconnect cursor must match an exact occurrence in this root’s canonical memory stream.');
  return { ...root, streams: { ...root.streams, memory: root.streams.memory.slice(0, found.seq + 1) } };
}

export function projectAi(root: RootSnapshot, scope: string): JsonObject {
  const state = foldState(root);
  const allowed = permittedScopes(state.scopes, scope);
  const records = publishedRecords(root).filter(r => allowed.has(r.scope));
  const visible = root.streams.memory.filter(f => allowed.has(String(f.payload.scope)));
  const turnFrames = visible.filter(f => ['turn.user', 'turn.assistant', 'collaboration.synthesized', 'client.conversation'].includes(String(f.payload.event)));
  const byWave = new Map(records.map(r => [r.frame.frame_hash, r]));
  const turns = turnFrames.slice(-AI_LIMITS.windowItems).map(frame => {
    const client = byWave.get(frame.frame_hash);
    const e = workEvent(frame.payload);
    return {
      bot: root.definition.root, role: e.event === 'turn.user' ? 'user' : 'assistant',
      actor: client ? client.data.actor : { id: e.event === 'turn.user' ? 'human' : root.definition.root, name: e.event === 'turn.user' ? 'Human' : root.definition.name, provider: 'canonical-core' },
      text: client ? client.data.content.text! : e.data.text!, source: reference(frame),
    };
  });
  const contribution = (kind: PublicationKind): JsonObject[] => records.filter(r => r.kind === kind)
    .slice(-AI_LIMITS.windowItems).map(r => ({ actor: r.data.actor, content: r.data.content, source: reference(r.frame), causes: r.data.causes }));
  const heads = viewFrontier(records);
  const candidates = heads.map(r => {
    let valid = true;
    try { validateViewState(root, r.scope, r.data.view!); } catch { valid = false; }
    return { source: reference(r.frame), actor: r.data.actor, parents: r.data.viewParents, intent: r.data.view, valid };
  });
  const status = heads.length > 1 ? 'conflict' : candidates.length && !candidates[0]!.valid ? 'invalidated' : heads.length ? 'resolved' : 'none';
  const progressFrame = status === 'resolved' && heads[0]!.data.view!.progress
    ? byWave.get(heads[0]!.data.view!.progress) : undefined;
  const snapshot: JsonObject = {
    schema: AI_PROJECTION_SCHEMA, root: root.definition.root, name: root.definition.name, scope,
    authority: { ...AUTHORITY, factualTruth: false, clientAssurance: 'root-signed-scoped-capability-attribution' },
    cursor: cursorFor(root),
    scopes: state.scopes.filter(s => allowed.has(s.id)).map(s => ({ id: s.id, parent: s.parent, name: s.name, kind: s.kind })),
    artifacts: [...state.artifacts.values()].filter(a => allowed.has(String(a.scope))).map(a => ({
      id: a.id!, scope: a.scope!, name: a.name!, mediaType: a.mediaType!, contentHash: a.contentHash!, source: a.source!,
    })),
    turns, activity: contribution('activity'), evidence: contribution('evidence'), attention: contribution('attention'),
    view: {
      status, heads: heads.map(h => h.frame.frame_hash), candidates,
      effective: status === 'resolved' ? heads[0]!.data.view! : null,
      progress: progressFrame ? progressFrame.data.content : null,
      conflicts: status === 'conflict' ? [{ kind: 'concurrent-view-intents', heads: heads.map(h => h.frame.frame_hash), resolutionRequired: true }] : [],
    },
    refusedHints: records.filter(r => r.data.viewRefusal !== null).slice(-AI_LIMITS.windowItems)
      .map(r => ({ source: reference(r.frame), actor: r.data.actor, diagnostic: r.data.viewRefusal })),
    history: {
      conversationRecords: turnFrames.length, clientPublications: records.length,
      windowItems: AI_LIMITS.windowItems,
      truncated: turnFrames.length > AI_LIMITS.windowItems || records.length > AI_LIMITS.windowItems,
      pagingAvailable: true,
    },
  };
  requireThat(Buffer.byteLength(canonicalJson(snapshot)) <= AI_LIMITS.snapshotBytes, 'projection-size',
    'This authorized projection exceeds the bounded snapshot size; canonical work remains available by scope/history page.');
  return snapshotJson(snapshot) as JsonObject;
}

export function publicHistoryFrame(frame: RappFrame): JsonObject {
  const e = workEvent(frame.payload);
  const publicKinds = ['turn.user', 'turn.assistant', 'collaboration.synthesized', 'work.progress', 'routine.tick',
    'client.conversation', 'client.activity', 'client.evidence', 'client.attention', 'client.view'];
  return { source: reference(frame), event: e.event, scope: e.scope,
    frame: publicKinds.includes(e.event) ? snapshotJson(frame) : null, controlRecord: !publicKinds.includes(e.event) };
}
