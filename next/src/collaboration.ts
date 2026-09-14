import { canonicalJson, signerOf, streamFor, type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, list, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { projectBot, publicWorkText, reference, type PublicTurn } from './projection.js';
import type { RootSnapshot, StoreSnapshot } from './repository.js';
import type { ModelProvider } from './spine.js';
import { publicationData } from './ai-contract.js';
import { memoryFrames, sourceReference } from './source-memory.js';

const SCHEMA = 'rapp-work.next/collaboration/1';
export interface PublicPerspective extends JsonObject {
  summary: string;
  disagreements: string[];
  unknowns: string[];
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
  const grant = memoryFrames(root).filter(f => f.payload.event === 'collaboration.granted' && workEvent(f.payload).data.peer === peer).at(-1);
  return grant && workEvent(grant.payload).data.mode === 'allow' ? grant : undefined;
}

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

function assertRequest(frame: RappFrame): JsonObject {
  const p = object(frame.payload, ['schema', 'root', 'to', 'operationId', 'question', 'callerGrant', 'recipientGrant'], ['briefRef', 'publicBrief']);
  requireThat(p.schema === SCHEMA && frame.kind === 'swarm.guidance', 'collaboration', 'A signed canonical guidance request is required.');
  requireThat(frame.stream_id === streamFor(String(p.root), 'swarm') && signerOf(frame) === p.root,
    'collaboration-binding', 'The public request must speak as its original signed root.');
  label(p.operationId);
  text(p.question, 2_000);
  requireThat((p.briefRef !== undefined) !== (p.publicBrief !== undefined), 'collaboration-binding', 'A request retains exactly one original brief reference or immutable legacy brief.');
  if (p.briefRef !== undefined) object(p.briefRef);
  else text(p.publicBrief, 2_000);
  return p;
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
      const selected = pair(transaction.snapshot, from, to);
      const existing = selected.caller.streams.swarm.find(f => f.payload.operationId === operationId);
      if (existing) {
        const p = assertRequest(existing);
        requireThat(p.to === to && p.question === question, 'idempotency-conflict', 'A collaboration request ID is already bound.');
        return { ...selected, request: existing, started: false };
      }
      const signer = this.bots.signer(from);
      requireThat(signer && this.bots.signer(to), 'signing-authority-unavailable', 'Both selected root signers must be available; unsigned requests are refused.');
      const request = await transaction.append({ root: from, family: 'swarm', kind: 'swarm.guidance',
        payload: {
          schema: SCHEMA, root: from, to, operationId, question,
          briefRef: sourceReference(selected.callerGrant),
          callerGrant: selected.callerGrant.frame_hash, recipientGrant: selected.recipientGrant.frame_hash,
        }, utc: this.bots.now(), expectedHead: selected.caller.streams.swarm.at(-1)?.frame_hash ?? null, signer });
      return { ...selected, request, started: true };
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
    if (status === 'completed') {
      const callerObservation = this.bots.spine.observe(from);
      try {
        const summary = publicPerspective(await this.bots.spine.compute(callerObservation, prepared.caller.definition.capability, {
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
      } catch {
        await this.bots.repository.transaction(async transaction => {
          const current = findRoot(transaction, from);
          await this.bots.appendEvent(transaction, current, 'provider.unavailable', {
            requestWave: prepared.request.frame_hash, summary: 'Public perspectives remain intact. Caller synthesis is unavailable; no agreement, action or retry was fabricated.',
          }, `synthesis-failed-${prepared.request.frame_hash}`);
        });
      } finally { await this.bots.spine.unobserve(callerObservation); }
    }
    return { status, request: prepared.request.frame_hash, response: response.frame_hash, transcript: await this.transcript(from) };
  }

  async transcript(root: string): Promise<PublicTurn[]> {
    const snapshot = await this.bots.repository.snapshot();
    const own = snapshot.roots.find(r => r.definition.root === root);
    requireThat(own, 'root-not-found', 'Choose an existing canonical root.');
    const requests = snapshot.roots.flatMap(r => r.streams.swarm).filter(f =>
      f.kind === 'swarm.guidance' && (f.payload.root === root || f.payload.to === root));
    const authorized = new Map(requests.map(r => [r.frame_hash, assertRequest(r)]));
    for (const request of requests) {
      const p = assertRequest(request);
      const caller = snapshot.roots.find(r => r.definition.root === p.root);
      const recipient = snapshot.roots.find(r => r.definition.root === p.to);
      const callerGrant = caller && memoryFrames(caller).find(f => f.frame_hash === p.callerGrant);
      const recipientGrant = recipient && memoryFrames(recipient).find(f => f.frame_hash === p.recipientGrant);
      requireThat(callerGrant?.payload.event === 'collaboration.granted'
        && recipientGrant?.payload.event === 'collaboration.granted'
        && workEvent(callerGrant.payload).data.mode === 'allow'
        && workEvent(recipientGrant.payload).data.mode === 'allow'
        && workEvent(callerGrant.payload).data.peer === p.to
        && workEvent(recipientGrant.payload).data.peer === p.root
        && (p.briefRef !== undefined ? canonicalJson(p.briefRef) === canonicalJson(sourceReference(callerGrant))
          : workEvent(callerGrant.payload).data.publicBrief === p.publicBrief),
      'collaboration-binding', 'A public request must retain both exact historical consent frames, not substitute a carried grant.');
    }
    const echoes = snapshot.roots.flatMap(r => r.streams.swarm).filter(f => {
      if (f.kind !== 'swarm.echo') return false;
      const request = requests.find(r => r.frame_hash === f.payload.requestWave);
      if (!request) return false;
      object(f.payload, ['schema', 'root', 'to', 'requestWave', 'requestParticle', 'recipientGrant', 'public', 'status', 'operationId']);
      requireThat(f.payload.root === request.payload.to && f.payload.to === request.payload.root
        && f.payload.requestParticle === request.payload_hash && f.payload.recipientGrant === request.payload.recipientGrant
        && signerOf(f) === f.payload.root && f.payload.schema === SCHEMA,
      'collaboration-binding', 'A public echo must bind the exact signed request particle, occurrence, recipient and grant.');
      publicPerspective(f.payload.public);
      return true;
    });
    const syntheses = memoryFrames(own).filter(f => f.payload.event === 'collaboration.synthesized'
      && authorized.has(String(workEvent(f.payload).data.requestWave)));
    const ordinary = memoryFrames(own).filter(f => ['turn.user', 'turn.assistant', 'client.conversation'].includes(String(f.payload.event)));
    const selected = await this.bots.repository.orderSelection(new Set([...requests, ...echoes, ...syntheses, ...ordinary].map(f => f.frame_hash)));
    return selected.map(frame => {
      const data = frame.kind.startsWith('memory.') ? workEvent(frame.payload).data : frame.payload;
      const role = frame.payload.event === 'turn.user' ? 'user' : 'assistant';
      const publicText = frame.kind === 'swarm.guidance' ? String(data.question)
        : frame.kind === 'swarm.echo' ? (() => {
          const p = publicPerspective(data.public);
          return [p.summary, ...p.disagreements.map(d => `Disagreement: ${d}`), ...p.unknowns.map(u => `Unknown: ${u}`)].join('\n');
        })() : frame.payload.event === 'client.conversation' ? (() => {
          const p = publicationData('conversation', data);
          return `[${p.actor.name} / ${p.actor.provider}] ${String(p.content.text)}`;
        })() : publicWorkText(frame);
      if (frame.payload.event === 'collaboration.synthesized' && data.format === 'rapp-work.synthesis-references/1') {
        const original = echoes.find(f => f.frame_hash === data.responseWave);
        requireThat(original && canonicalJson(sourceReference(original)) === canonicalJson(data.responseRef),
          'collaboration-binding', 'A synthesis must retain its peer’s exact original source, not copied dissent or substituted history.');
      }
      return { role, speaker: role === 'user' ? 'human' : String(frame.payload.root),
        text: publicText, source: reference(frame), origin: sourceReference(frame), replyTo: typeof data.requestWave === 'string' ? data.requestWave : null };
    });
  }
}
