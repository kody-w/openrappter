import { type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { projectBot, reference } from './projection.js';
import type { RootSnapshot, StoreSnapshot } from './repository.js';
import type { ModelProvider, Observation } from './spine.js';
import { sourceReference } from './source-memory.js';
import {
  assertCollaborationRequest, peerGrant, projectTranscript, publicPerspective, verifiedTranscript,
  type PublicPerspective, type TranscriptOptions, type TranscriptPage, type TranscriptTurn,
} from './transcript.js';

const SCHEMA = 'rapp-work.next/collaboration/1';

function pair(snapshot: StoreSnapshot, from: string, to: string): { caller: RootSnapshot; recipient: RootSnapshot; callerGrant: RappFrame; recipientGrant: RappFrame } {
  const caller = snapshot.roots.find(r => r.definition.root === from);
  const recipient = snapshot.roots.find(r => r.definition.root === to);
  requireThat(from !== to && caller && recipient && !projectBot(caller).hidden && !projectBot(recipient).hidden,
    'collaboration-scope', 'Collaboration requires two distinct visible root GUIDs.');
  requireThat(caller.definition.signer === from && recipient.definition.signer === to, 'signing-authority-unavailable',
    'Independent keyed root signers are required for canonical collaboration.');
  const callerGrant = peerGrant(caller, to);
  const recipientGrant = peerGrant(recipient, from);
  requireThat(callerGrant && recipientGrant, 'collaboration-approval',
    'Both independent roots must explicitly authorize this bounded public perspective exchange.');
  return { caller, recipient, callerGrant, recipientGrant };
}

export class Collaboration {
  constructor(readonly bots: Bots, readonly provider: ModelProvider) {}

  async grant(root: string, peer: string, publicBrief: string, mode: 'allow' | 'revoke', operationId: string): Promise<JsonObject> {
    requireThat(mode === 'allow' || mode === 'revoke', 'collaboration-approval', 'A human may allow or revoke one bounded peer relationship.');
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      findRoot(transaction, peer);
      requireThat(root !== peer && snapshot.definition.signer === root, 'collaboration-approval', 'A keyed root may grant another distinct root, not merge with it.');
      const frame = await this.bots.appendEvent(transaction, snapshot, 'collaboration.granted',
        { peer, publicBrief: text(publicBrief, 2_000), mode, scope: 'one-hop-public-perspective', actor: 'local-operator' }, operationId);
      return { source: frame.frame_hash, root, peer, mode, scope: 'one-hop-public-perspective' };
    });
  }

  async ask(from: string, to: string, question: string, operationId: string): Promise<JsonObject> {
    text(question, 2_000);
    label(operationId);
    const prepared = await this.bots.repository.transaction(async transaction => {
      const caller = findRoot(transaction, from);
      const existing = caller.streams.swarm.find(f => f.payload.operationId === operationId);
      if (existing) {
        const p = assertCollaborationRequest(existing);
        requireThat(p.to === to && p.question === question, 'idempotency-conflict', 'A collaboration request ID is already bound.');
        return { request: existing, started: false as const };
      }
      const selected = pair(transaction.snapshot, from, to);
      const signer = this.bots.signer(from);
      requireThat(signer && this.bots.signer(to), 'signing-authority-unavailable', 'Both selected root signers must be available; unsigned requests are refused.');
      const request = await transaction.append({ root: from, family: 'swarm', kind: 'swarm.guidance',
        payload: {
          schema: SCHEMA, root: from, to, operationId, question,
          briefRef: sourceReference(selected.callerGrant),
          callerGrant: selected.callerGrant.frame_hash, recipientGrant: selected.recipientGrant.frame_hash,
        }, utc: this.bots.now(), expectedHead: selected.caller.streams.swarm.at(-1)?.frame_hash ?? null, signer });
      return { ...selected, request, started: true as const };
    });
    if (!prepared.started) return { status: 'recorded-not-replayed', transcript: await this.transcript(from), request: prepared.request.frame_hash };
    const recipientObservation = this.bots.spine.observe(to);
    let perspective: PublicPerspective;
    let status = 'completed';
    try {
      const current = pair(await this.bots.repository.snapshot(), from, to);
      requireThat(current.callerGrant.frame_hash === prepared.callerGrant.frame_hash
        && current.recipientGrant.frame_hash === prepared.recipientGrant.frame_hash,
      'collaboration-approval', 'The public exchange authority changed before dispatch.');
      perspective = publicPerspective(await this.bots.spine.compute(recipientObservation, current.recipient.definition.capability, {
        root: to, scope: 'root', thought: question, purpose: 'perspective',
        context: { root: to, scope: 'root',
          publicBrief: String(workEvent(current.recipientGrant.payload).data.publicBrief),
          request: prepared.request.payload,
          callerBrief: { source: sourceReference(current.callerGrant), text: String(workEvent(current.callerGrant.payload).data.publicBrief) },
          sources: [reference(prepared.request), reference(current.recipientGrant), reference(current.callerGrant)] },
      }, this.provider));
    } catch {
      status = 'unavailable';
      perspective = { summary: 'This root’s selected provider or verified binding was unavailable; no private context or fallback was used.',
        disagreements: [], unknowns: ['No public perspective was produced.'] };
    } finally { await this.bots.spine.unobserve(recipientObservation); }
    const response = await this.bots.repository.transaction(async transaction => {
      const current = pair(transaction.snapshot, from, to);
      requireThat(current.callerGrant.frame_hash === prepared.callerGrant.frame_hash
        && current.recipientGrant.frame_hash === prepared.recipientGrant.frame_hash,
      'collaboration-approval', 'An interleaved grant change prevents publishing this response.');
      const signer = this.bots.signer(to);
      requireThat(signer, 'signing-authority-unavailable', 'The recipient root signer is unavailable.');
      return transaction.append({
        root: to, family: 'swarm', kind: 'swarm.echo', utc: this.bots.now(),
        expectedHead: current.recipient.streams.swarm.at(-1)?.frame_hash ?? null, signer,
        payload: {
          schema: SCHEMA, root: to, to: from, requestWave: prepared.request.frame_hash,
          requestParticle: prepared.request.payload_hash, recipientGrant: prepared.recipientGrant.frame_hash,
          public: perspective, status, operationId: `echo-${prepared.request.frame_hash}`,
        },
      });
    });
    await this.bots.repository.transaction(async transaction => {
      await this.bots.appendEvent(transaction, findRoot(transaction, from), 'collaboration.perspective',
        { requestWave: prepared.request.frame_hash, responseWave: response.frame_hash, peer: to, status },
        `perspective-${prepared.request.frame_hash}`);
    });
    let synthesisStatus = 'not-requested';
    if (status === 'completed') {
      let callerObservation: Observation | null = null;
      try {
        const dispatch = pair(await this.bots.repository.snapshot(), from, to);
        requireThat(dispatch.callerGrant.frame_hash === prepared.callerGrant.frame_hash
          && dispatch.recipientGrant.frame_hash === prepared.recipientGrant.frame_hash,
        'collaboration-approval', 'Synthesis requires the unchanged original authority before starting a new model call.');
        callerObservation = this.bots.spine.observe(from);
        const summary = publicPerspective(await this.bots.spine.compute(callerObservation, dispatch.caller.definition.capability, {
          root: from, scope: 'root', thought: question, purpose: 'synthesis',
          context: { root: from, scope: 'root', publicRequest: prepared.request.payload, publicPerspective: response.payload,
            sources: [reference(prepared.request), reference(response)], consensus: false, actions: 'review-required' },
        }, this.provider));
        await this.bots.repository.transaction(async transaction => {
          const current = pair(transaction.snapshot, from, to);
          requireThat(current.callerGrant.frame_hash === prepared.callerGrant.frame_hash
            && current.recipientGrant.frame_hash === prepared.recipientGrant.frame_hash, 'collaboration-approval', 'Synthesis authority changed.');
          await this.bots.appendEvent(transaction, current.caller, 'collaboration.synthesized', {
            format: 'rapp-work.synthesis-references/1', responseRef: sourceReference(response),
            requestWave: prepared.request.frame_hash, responseWave: response.frame_hash,
            public: summary, consensus: false, actions: 'review-required',
          }, `synthesis-${prepared.request.frame_hash}`);
        });
        synthesisStatus = 'completed';
      } catch {
        synthesisStatus = 'unavailable';
        await this.bots.repository.transaction(async transaction => {
          const current = findRoot(transaction, from);
          await this.bots.appendEvent(transaction, current, 'provider.unavailable', {
            requestWave: prepared.request.frame_hash, summary: 'Public perspectives remain intact. Caller synthesis is unavailable or no longer authorized; no agreement, action or retry was fabricated.',
          }, `synthesis-failed-${prepared.request.frame_hash}`);
        });
      } finally { if (callerObservation) await this.bots.spine.unobserve(callerObservation); }
    }
    return { status: status === 'completed' && synthesisStatus !== 'completed' ? 'partial' : status,
      responseStatus: status, synthesisStatus, request: prepared.request.frame_hash, response: response.frame_hash, transcript: await this.transcript(from) };
  }

  async transcript(root: string): Promise<TranscriptTurn[]> {
    const snapshot = await this.bots.repository.snapshot();
    return verifiedTranscript(snapshot, root);
  }

  async transcriptPage(root: string, options: TranscriptOptions = {}): Promise<TranscriptPage> {
    const snapshot = await this.bots.repository.snapshot();
    return projectTranscript(snapshot, root, 'root', options);
  }
}
