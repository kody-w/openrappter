import { Bots, findRoot } from './bots.js';
import { canonicalJson, contentHash, type JsonObject } from './canonical.js';
import { eventKind, eventPayload, label, object } from './contract.js';
import { requireThat } from './errors.js';
import { foldState, permittedScopes } from './state.js';
import { ClientAuthority, actorFor } from './ai-authority.js';
import {
  AI_LIMITS, hashes, publicationContent, publicationKind, publicationRight, viewIntent,
  type PublicationData,
} from './ai-contract.js';
import { atCursor, cursorFor, projectAi, publicHistoryFrame, publishedRecords, scopedFrames, validateViewState, viewFrontier } from './ai-projector.js';
import { reference } from './projection.js';
import { catchUpTimeline } from './catch-up.js';
import { CanonicalComputerReplay } from './computer-replay.js';

export class AiProjectionApi {
  readonly authority: ClientAuthority;
  constructor(readonly bots: Bots, readonly computerReplay?: CanonicalComputerReplay) { this.authority = new ClientAuthority(bots); }

  async read(root: string, capability: string, cursor?: unknown): Promise<JsonObject> {
    const selected = await this.authority.authorize(root, capability, ['projection.read']);
    return projectAi(cursor === undefined ? selected.root : atCursor(selected.root, cursor), selected.grant.data.scope);
  }

  async catchUp(root: string, capability: string, options: unknown = {}): Promise<JsonObject> {
    const request = object(options);
    const selected = await this.authority.authorize(root, capability, request.guest === undefined ? ['projection.read'] : ['projection.read', 'guest.replay']);
    return catchUpTimeline(selected.root, selected.grant.data.scope, request, this.computerReplay);
  }

  async artifact(root: string, capability: string, id: string): Promise<JsonObject> {
    label(id);
    const selected = await this.authority.authorize(root, capability, ['projection.read']);
    const state = foldState(selected.root);
    const artifact = state.artifacts.get(id);
    requireThat(artifact && permittedScopes(state.scopes, selected.grant.data.scope).has(String(artifact.scope)),
      'client-scope', 'Only an existing authorized canonical artifact may be read; no host path or URL is accepted.');
    return { root, artifact };
  }

  async publish(root: string, capability: string, value: unknown, requestId: string): Promise<JsonObject> {
    label(requestId);
    const input = object(value, ['kind', 'content', 'causes'], ['scope', 'view', 'viewParents']);
    requireThat(Buffer.byteLength(canonicalJson(input)) <= AI_LIMITS.requestBytes, 'publication-size', 'Publications are bounded to 32 KiB.');
    const kind = publicationKind(input.kind);
    const content = publicationContent(kind, input.content);
    const causes = hashes(input.causes);
    const digest = contentHash(input);
    return this.bots.repository.transaction(async tx => {
      const snapshot = findRoot(tx, root);
      const utc = this.bots.now();
      const grant = this.authority.authenticate(snapshot, root, capability, [publicationRight(kind)], utc);
      const scope = input.scope === undefined ? grant.data.scope : label(input.scope);
      const state = foldState(snapshot);
      const allowed = permittedScopes(state.scopes, grant.data.scope);
      requireThat(allowed.has(scope), 'client-scope', 'The publication cannot leave its canonical grant scope.');
      const operationId = `ai-${contentHash({ client: grant.data.client, requestId })}`;
      const duplicate = snapshot.streams.memory.find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(object(duplicate.payload.data).requestHash === digest, 'idempotency-conflict', 'This client request ID already records different work.');
        return { receipt: reference(duplicate), attribution: object(duplicate.payload.data).actor!, duplicate: true };
      }
      const recent = snapshot.streams.memory.filter(f => f.payload.event?.toString().startsWith('client.')
        && object(f.payload.data).actor && object(object(f.payload.data).actor).id === grant.data.client
        && Date.parse(f.utc) > Date.parse(utc) - 60_000);
      requireThat(recent.length < AI_LIMITS.publicationsPerMinute, 'client-rate', 'The canonical per-client publication rate is exhausted; retries must wait, not drop work.');
      const known = new Set([...snapshot.streams.body, ...snapshot.streams.memory, ...snapshot.streams.swarm].map(f => f.frame_hash));
      requireThat(causes.every(cause => known.has(cause)), 'causality', 'Causal references must be prior occurrences of this exact root.');
      const material = scopedFrames(snapshot, scope);
      const refs = kind === 'activity' ? hashes(content.evidence, 8)
        : kind === 'evidence' || kind === 'attention' ? hashes(content.references, 8) : [];
      requireThat(refs.every(ref => material.has(ref) && !['client.granted', 'client.revoked'].includes(String(material.get(ref)!.payload.event))),
        'client-scope', 'Evidence must refer to authorized canonical work, not another scope, root or credential record.');
      const data: PublicationData = {
        actor: actorFor(grant), requestHash: digest, content, causes,
        view: null, viewParents: [], viewRefusal: null,
      };
      if (input.view !== undefined) {
        try {
          requireThat(grant.data.rights.includes('view.publish'), 'view-authority', 'A work publication does not imply view authority.');
          const view = viewIntent(input.view);
          validateViewState(snapshot, scope, view);
          const parents = hashes(input.viewParents ?? [], 8);
          const priorViews = new Map(publishedRecords(snapshot).filter(r => r.data.view !== null).map(r => [r.frame.frame_hash, r]));
          const viewScope = permittedScopes(state.scopes, scope);
          requireThat(parents.every(p => priorViews.has(p) && viewScope.has(priorViews.get(p)!.scope)),
            'view-causality', 'View parents must identify authorized canonical view occurrences.');
          requireThat(grant.data.rights.includes('view.resolve') || parents.every(p => priorViews.get(p)!.data.actor.id === grant.data.client),
            'view-authority', 'Consuming another client’s view head requires explicit resolution authority.');
          requireThat(viewFrontier([...priorViews.values()]).filter(p => !parents.includes(p.frame.frame_hash)).length < AI_LIMITS.viewHeads,
            'view-bound', 'Resolve existing view conflicts before adding more pending projection heads.');
          data.view = view;
          data.viewParents = parents;
        } catch {
          data.viewRefusal = { code: 'view-hint-refused', message: 'Unsupported, unauthorized or unavailable projection hint refused; canonical work is preserved.' };
        }
      } else requireThat(input.viewParents === undefined, 'view-contract', 'View parents require a declarative view intent.');
      requireThat(kind !== 'view' || data.view !== null, 'view-hint-refused', 'No supported authorized view intent was provided. Prior work is unchanged.');
      const signer = this.bots.signer(root);
      requireThat(signer, 'signing-authority-unavailable', 'The root publication signer is unavailable; unsigned attribution is refused.');
      const frame = await tx.append({ root, family: 'memory', kind: eventKind(`client.${kind}`), utc,
        payload: eventPayload(root, scope, operationId, `client.${kind}`, data),
        expectedHead: snapshot.streams.memory.at(-1)?.frame_hash ?? null, signer });
      return { receipt: reference(frame), attribution: data.actor, duplicate: false, viewAccepted: data.view !== null, viewRefusal: data.viewRefusal };
    });
  }

  async history(root: string, capability: string, cursor: unknown = null, limit: number = AI_LIMITS.pageEvents): Promise<JsonObject> {
    requireThat(Number.isInteger(limit) && limit >= 1 && limit <= AI_LIMITS.pageEvents, 'page-bound', 'History pages contain at most sixteen canonical occurrences.');
    const selected = await this.authority.authorize(root, capability, ['projection.read']);
    const before = atCursor(selected.root, cursor);
    const start = before.streams.memory.length;
    const segment = selected.root.streams.memory.slice(start, start + limit);
    const allowed = permittedScopes(foldState(selected.root).scopes, selected.grant.data.scope);
    const records = segment.filter(f => allowed.has(String(f.payload.scope))).map(publicHistoryFrame);
    const result: JsonObject = {
      root, from: cursor === null ? null : cursorFor(before), cursor: segment.length ? reference(segment.at(-1)!) : cursorFor(before),
      records, more: start + segment.length < selected.root.streams.memory.length,
      canonicalWorkPreserved: true,
    };
    requireThat(Buffer.byteLength(canonicalJson(result)) <= AI_LIMITS.snapshotBytes, 'page-size', 'Reduce the page limit to stay within the bounded response size.');
    return result;
  }
}
