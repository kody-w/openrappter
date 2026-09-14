import { canonicalJson, contentHash, isUtc, type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, object, text, workEvent } from './contract.js';
import { Conversation } from './conversation.js';
import { Refusal, requireThat } from './errors.js';
import { wave } from './intent.js';
import { projectBot, publicWorkText } from './projection.js';
import type { RootSnapshot } from './repository.js';
import { memoryFrames, sourceReference } from './source-memory.js';
import { canonicalClarification, channelPolicy, DEFAULT_CHANNEL_POLICY, isQuiet, questionPending, turnAttribution, type ChannelPolicy } from './channel-contract.js';
import { PrivateChannelBindings, type PrivateChannelMaterial } from './channel-runtime.js';
import { untilAborted } from './async.js';
import { assertCanonicalSelection } from './canonical-forks.js';

export interface PrivateChannelPort {
  readonly channel: 'imessage';
  readonly available: boolean;
  readonly idempotentDelivery: true;
  preflight(input: { root: string; material: PrivateChannelMaterial; deliveryIds: readonly string[]; signal: AbortSignal }): Promise<{ status: 'ready' | 'unavailable' | 'deferred' }>;
  send(input: { root: string; contactRef: string; permissionRef: string; shortcut: string | null; credential: string | null;
    deliveryId: string; text: string; signal: AbortSignal }): Promise<{ receipt: string }>;
  verifyIncoming(envelope: unknown): Promise<{ contactRef: string; messageId: string; text: string }>;
}
export class DisabledIMessage implements PrivateChannelPort {
  readonly channel = 'imessage';
  readonly available = false;
  readonly idempotentDelivery = true;
  async preflight(): Promise<{ status: 'unavailable' }> { return { status: 'unavailable' }; }
  async send(): Promise<{ receipt: string }> {
    throw new Refusal('channel-disabled', 'Production iMessage is disabled until explicit local OS permission and contact binding are verified.');
  }
  async verifyIncoming(): Promise<never> { throw new Refusal('channel-disabled', 'No authenticated iMessage transport is active.'); }
}

function binding(root: RootSnapshot): RappFrame | undefined {
  return memoryFrames(root).filter(f => f.payload.event === 'channel.bound').at(-1);
}
interface BoundChannel { frame: RappFrame; id: string; policy: ChannelPolicy }

export function referenceRecap(root: RootSnapshot, queued: JsonObject): { summary: string; sources: JsonObject[] } {
  assertCanonicalSelection(root);
  if (queued.format !== 'rapp-work.recap-references/1' && queued.format !== 'rapp-work.question-references/1') {
    requireThat(queued.format === undefined && queued.sourceRefs === undefined, 'recap-source', 'Unknown recap references cannot become a legacy summary.');
    return { summary: text(queued.summary, 3_000), sources: [] }; // immutable historical record, never rewritten
  }
  const refs = queued.sourceRefs;
  requireThat(Array.isArray(refs) && refs.length <= 6, 'recap-source', 'A recap contains bounded canonical source references only.');
  const byHash = new Map(memoryFrames(root).map(f => [f.frame_hash, f]));
  const frames = refs.map(value => {
    const ref = object(value);
    const frame = byHash.get(String(ref.frame_hash));
    requireThat(frame && canonicalJson(sourceReference(frame)) === canonicalJson(ref), 'recap-source',
      'The original source GUID/scope/stream occurrence is unavailable; no copied activity fallback is permitted.');
    return frame;
  });
  const summary = frames.length ? frames.map(frame => {
    const event = workEvent(frame.payload);
    if (queued.format === 'rapp-work.question-references/1') {
      const marker = canonicalClarification(frame);
      requireThat(marker, 'clarify-binding', 'A notification requires the original same-publication clarify marker and assistant turn.');
      return marker.questions.map(q => q.text).join('\n');
    }
    const value = event.event === 'client.conversation' ? object(event.data.content).text
      : event.event === 'collaboration.synthesized' ? publicWorkText(frame) : event.data.text ?? event.data.summary;
    return `[${event.scope}] ${event.event}: ${String(value ?? 'Recorded source outcome').slice(0, 260)}`;
  }).join('\n') : `${root.definition.name}: no completed source work is referenced.`;
  return { summary, sources: refs.map(value => object(value)) };
}

export class PrivateChannels {
  readonly bindings: PrivateChannelBindings;
  readonly #cancelled = new Set<string>();
  readonly #inflight = new Map<string, AbortController>();
  readonly #invalidated = new Set<string>();
  #observer: Promise<void> | null = null;
  constructor(readonly bots: Bots, readonly conversation: Conversation, readonly port: PrivateChannelPort = new DisabledIMessage(),
    bindings = new PrivateChannelBindings(bots.repository.directory)) {
    this.bindings = bindings;
    bots.repository.onPublication(notice => {
      if (notice.event === null || notice.event.startsWith('channel.')) return;
      this.#invalidated.add(notice.root);
      return this.#startObserver();
    });
  }
  #startObserver(): Promise<void> {
    if (!this.#observer) this.#observer = this.#observe().finally(() => {
      this.#observer = null;
      if (this.#invalidated.size) void this.#startObserver().catch(() => {
        process.stderr.write('Channel publication reconstruction failed; canonical work is retained for explicit review.\n');
      });
    });
    return this.#observer;
  }
  async #observe(): Promise<void> {
    while (this.#invalidated.size) {
      const root = this.#invalidated.values().next().value!;
      this.#invalidated.delete(root);
      await this.consider(root);
    }
  }
  async drain(): Promise<void> { while (this.#observer) await this.#observer; }

  #binding(root: RootSnapshot): BoundChannel {
    const frame = binding(root);
    const data = frame && workEvent(frame.payload).data;
    requireThat(frame && data?.schema === 'rapp-work.channel-binding-ref/1' && data.enabled === true,
      'channel-binding', 'An enabled owner-bound private runtime reference is required; legacy contact-bearing records cannot activate delivery.');
    return { frame, id: wave(data.bindingId), policy: channelPolicy(data.policy) };
  }

  async bind(root: string, contactRef: string, permissionRef: string, enabled: boolean, operationId: string,
    policy: unknown = DEFAULT_CHANNEL_POLICY, extra: { shortcut?: string; credential?: string } = {}): Promise<JsonObject> {
    requireThat(typeof enabled === 'boolean', 'channel-binding', 'A local operator must explicitly enable or disable the contact binding.');
    const selectedPolicy = channelPolicy(policy);
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before binding a private channel.');
      const bindingId = await this.bindings.put(root, { contactRef, permissionRef, shortcut: extra.shortcut ?? null, credential: extra.credential ?? null }, operationId);
      const frame = await this.bots.appendEvent(transaction, snapshot, 'channel.bound',
        { schema: 'rapp-work.channel-binding-ref/1', channel: 'imessage', bindingId, policy: selectedPolicy,
          enabled, scope: 'conversation-and-public-recaps', actor: 'local-operator' }, operationId);
      return { root, source: frame.frame_hash, bindingId, transportEnabled: this.port.available && enabled,
        productionPermissionVerifiedByThisCommand: false };
    });
  }

  async consider(root: string): Promise<JsonObject> {
    const snapshot = await this.bots.repository.root(root);
    const selected = binding(snapshot);
    if (projectBot(snapshot).hidden || !selected || workEvent(selected.payload).data.schema !== 'rapp-work.channel-binding-ref/1'
      || workEvent(selected.payload).data.enabled !== true) return { root, queued: 0, effects: 0 };
    const policy = channelPolicy(workEvent(selected.payload).data.policy);
    if (!policy.automaticQuestions) return { root, queued: 0, effects: 0 };
    const questions = memoryFrames(snapshot).filter(f => canonicalClarification(f) && questionPending(snapshot, f.frame_hash));
    let queued = 0;
    for (const source of questions) {
      const result = await this.bots.repository.transaction(async tx => {
        const current = findRoot(tx, root), bound = this.#binding(current);
        if (projectBot(current).hidden || !bound.policy.automaticQuestions || !questionPending(current, source.frame_hash)) return false;
        const frames = memoryFrames(current);
        const cancelled = frames.filter(f => f.payload.event === 'channel.cancelled').map(f => workEvent(f.payload).data.deliveryId);
        if (frames.some(f => cancelled.includes(f.frame_hash) && Array.isArray(workEvent(f.payload).data.sourceRefs)
          && (workEvent(f.payload).data.sourceRefs as JsonObject[]).some(ref => ref.frame_hash === source.frame_hash))) return false;
        const operationId = `question-${contentHash({ source: source.frame_hash, binding: bound.frame.frame_hash })}`;
        if (memoryFrames(current).some(f => f.payload.operationId === operationId)) return false;
        requireThat(this.#pending(current).length < bound.policy.maxPending, 'channel-queue-bound', 'Pending notifications require owner attention before more queueing.');
        await this.bots.appendEvent(tx, current, 'channel.queued', {
          channel: 'imessage', kind: 'question', bindingWave: bound.frame.frame_hash,
          format: 'rapp-work.question-references/1', sourceRefs: [sourceReference(source)],
          expiresUtc: new Date(Date.parse(this.bots.now()) + bound.policy.ttlSeconds * 1_000).toISOString(),
        }, operationId);
        return true;
      });
      if (result) queued++;
    }
    return { root, queued, effects: 0 };
  }

  async queueRecap(root: string, operationId: string): Promise<JsonObject> {
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      const projection = projectBot(snapshot);
      const selected = this.#binding(snapshot);
      requireThat(!projection.hidden,
        'channel-binding', 'An explicit current root/contact/permission binding is required.');
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(duplicate.payload.event === 'channel.queued', 'idempotency-conflict', 'This request ID is already used.');
        return { deliveryId: duplicate.frame_hash, ...referenceRecap(snapshot, workEvent(duplicate.payload).data) };
      }
      const meaningful = memoryFrames(snapshot).filter(f =>
        ['turn.assistant', 'client.conversation', 'work.progress', 'routine.tick', 'organization.applied', 'collaboration.synthesized'].includes(String(f.payload.event))).slice(-6);
      requireThat(this.#pending(snapshot).length < selected.policy.maxPending, 'channel-queue-bound', 'The bounded pending delivery queue is full.');
      const frame = await this.bots.appendEvent(transaction, snapshot, 'channel.queued', {
        channel: 'imessage', kind: 'recap', bindingWave: selected.frame.frame_hash,
        format: 'rapp-work.recap-references/1', sourceRefs: meaningful.map(sourceReference),
        expiresUtc: new Date(Date.parse(this.bots.now()) + selected.policy.ttlSeconds * 1_000).toISOString(),
      }, operationId);
      return { deliveryId: frame.frame_hash, ...referenceRecap(snapshot, workEvent(frame.payload).data) };
    });
  }

  async deliver(root: string, deliveryId: string, operationId: string): Promise<JsonObject> {
    return this.flush(root, [deliveryId], operationId);
  }

  #has(frame: RappFrame, deliveryId: string): boolean {
    const data = workEvent(frame.payload).data;
    return data.deliveryId === deliveryId || (Array.isArray(data.deliveryIds) && data.deliveryIds.includes(deliveryId));
  }
  #status(root: RootSnapshot, id: string): string {
    const frames = memoryFrames(root).filter(f => this.#has(f, id));
    if (frames.some(f => f.payload.event === 'channel.outcome' && workEvent(f.payload).data.status === 'delivered')) return 'delivered';
    if (frames.some(f => f.payload.event === 'channel.attempt' && !frames.some(outcome => outcome.payload.event === 'channel.outcome'
      && workEvent(outcome.payload).data.attempt === f.frame_hash && workEvent(outcome.payload).data.status === 'not-submitted'))) return 'uncertain';
    if (frames.some(f => f.payload.event === 'channel.cancelled')) return 'cancelled';
    const queue = memoryFrames(root).find(f => f.frame_hash === id && f.payload.event === 'channel.queued');
    if (queue && workEvent(queue.payload).data.kind === 'question'
      && (workEvent(queue.payload).data.sourceRefs as JsonObject[]).some(ref => !questionPending(root, String(ref.frame_hash)))) return 'resolved';
    return 'pending';
  }
  #pending(root: RootSnapshot): RappFrame[] {
    return memoryFrames(root).filter(f => f.payload.event === 'channel.queued' && this.#status(root, f.frame_hash) === 'pending');
  }
  #preflight(root: RootSnapshot, id: string): RappFrame | undefined {
    return memoryFrames(root).filter(f => f.payload.event === 'channel.preflight' && this.#has(f, id)).at(-1);
  }
  #eligibility(root: RootSnapshot, ids: string[], bound: BoundChannel, utc: string): string | null {
    if (projectBot(root).hidden) return 'root-hidden';
    if (ids.some(id => this.#cancelled.has(`${root.definition.root}:${id}`) || this.#status(root, id) === 'cancelled')) return 'cancelled';
    const frames = memoryFrames(root);
    for (const id of ids) {
      const queue = frames.find(f => f.frame_hash === id && f.payload.event === 'channel.queued');
      requireThat(queue && workEvent(queue.payload).data.bindingWave === bound.frame.frame_hash, 'channel-binding', 'Every approved delivery must retain this exact current binding.');
      const data = workEvent(queue.payload).data;
      requireThat(isUtc(data.expiresUtc), 'channel-binding', 'Legacy unbounded queues require fresh owner review.');
      if (data.expiresUtc <= utc) return 'expired';
      if (data.kind === 'question' && (data.sourceRefs as JsonObject[]).some(ref => !questionPending(root, String(ref.frame_hash)))) return 'question-resolved';
    }
    if (isQuiet(bound.policy, utc)) return 'quiet-hours';
    const attempts = frames.filter(f => f.payload.event === 'channel.attempt' && !frames.some(outcome => outcome.payload.event === 'channel.outcome'
      && workEvent(outcome.payload).data.attempt === f.frame_hash && workEvent(outcome.payload).data.status === 'not-submitted'));
    if (attempts.filter(f => Date.parse(f.utc) > Date.parse(utc) - 3_600_000).length >= bound.policy.maxPerHour) return 'rate-bound';
    const last = attempts.at(-1);
    if (last && Date.parse(utc) - Date.parse(last.utc) < bound.policy.minIntervalSeconds * 1_000) return 'minimum-interval';
    return null;
  }

  async flush(root: string, values: string[], operationId: string): Promise<JsonObject> {
    label(operationId);
    requireThat(Array.isArray(values) && values.length > 0 && values.length <= 4, 'channel-batch', 'Approve one bounded exact delivery batch.');
    const ids = values.map(wave);
    requireThat(new Set(ids).size === ids.length, 'channel-batch', 'A delivery batch cannot duplicate a question.');
    const keys = ids.map(id => `${root}:${id}`);
    if (keys.some(key => this.#inflight.has(key))) return { status: 'busy', deliveryIds: ids, replayed: false };
    if (keys.some(key => this.#cancelled.has(key))) return { status: 'cancelled', deliveryIds: ids, replayed: false };
    const controller = new AbortController();
    for (const key of keys) this.#inflight.set(key, controller);
    let active: Promise<unknown> | null = null, settled = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => { for (const key of keys) if (this.#inflight.get(key) === controller) this.#inflight.delete(key); };
    try {
      const prepared = await this.bots.repository.transaction(async tx => {
        const current = findRoot(tx, root), bound = this.#binding(current);
        requireThat(!projectBot(current).hidden, 'bot-hidden', 'Hidden roots cannot approve delivery.');
        requireThat(ids.length <= bound.policy.maxBatch, 'channel-batch', 'This digest exceeds the reviewed batch bound.');
        const existing = memoryFrames(current).find(f => f.payload.operationId === operationId);
        if (existing) {
          requireThat(existing.payload.event === 'channel.preflight' && canonicalJson(workEvent(existing.payload).data.deliveryIds) === canonicalJson(ids),
            'idempotency-conflict', 'A delivery approval ID is already bound to another batch.');
          return { started: false as const, status: 'already-recorded-or-uncertain' };
        }
        const statuses = ids.map(id => this.#status(current, id));
        if (statuses.some(s => s !== 'pending')) return { started: false as const, status: statuses.includes('uncertain') ? 'uncertain' : statuses.find(s => s !== 'pending')! };
        const prior = ids.map(id => this.#preflight(current, id));
        const generations = prior.map(f => f ? Number(workEvent(f.payload).data.generation) : 0);
        requireThat(new Set(generations).size === 1, 'channel-batch-generation', 'Digest only compatible preflight generations; do not silently omit a question.');
        const now = this.bots.now();
        for (const previous of prior) if (previous) {
          const outcome = memoryFrames(current).find(f => workEvent(f.payload).data.preflight === previous.frame_hash
            && (f.payload.event === 'channel.preflight.outcome' || (f.payload.event === 'channel.outcome' && workEvent(f.payload).data.status === 'not-submitted')));
          if (!outcome && String(workEvent(previous.payload).data.expiresUtc) > now) return { started: false as const, status: 'busy' };
          if (outcome && Date.parse(now) < Date.parse(outcome.utc) + bound.policy.retrySeconds * 1_000) return { started: false as const, status: 'deferred' };
        }
        requireThat(generations[0]! < 32, 'channel-preflight-bound', 'This delivery requires explicit reconciliation after its preflight ceiling.');
        const reason = this.#eligibility(current, ids, bound, now);
        const frame = await this.bots.appendEvent(tx, current, 'channel.preflight', {
          deliveryIds: ids, bindingWave: bound.frame.frame_hash, generation: generations[0]! + 1,
          actor: 'local-operator', expiresUtc: new Date(Date.parse(now) + bound.policy.preflightSeconds * 1_000).toISOString(),
        }, operationId);
        return { started: true as const, frame, bound, reason };
      });
      if (!prepared.started) return { status: prepared.status, deliveryIds: ids, replayed: false };
      const noSend = async (status: string, reason: string): Promise<JsonObject> => {
        await this.bots.repository.transaction(async tx => this.bots.appendEvent(tx, findRoot(tx, root), 'channel.preflight.outcome', {
          preflight: prepared.frame.frame_hash, deliveryIds: ids, generation: workEvent(prepared.frame.payload).data.generation!,
          status, reason, submitted: false,
        }, `preflight-${prepared.frame.frame_hash}`));
        return { status, reason, deliveryIds: ids, preflight: prepared.frame.frame_hash,
          generation: workEvent(prepared.frame.payload).data.generation!, submitted: false, replayed: false };
      };
      if (prepared.reason) return noSend(prepared.reason === 'cancelled' ? 'cancelled' : 'deferred', prepared.reason);
      if (!this.port.available) return noSend('unavailable', 'transport-disabled');
      const expiresUtc = workEvent(prepared.frame.payload).data.expiresUtc;
      requireThat(isUtc(expiresUtc), 'channel-preflight', 'The selected preflight must retain its original canonical deadline.');
      const remaining = Math.min(prepared.bound.policy.preflightSeconds * 1_000, Date.parse(expiresUtc) - Date.parse(this.bots.now()));
      if (remaining <= 0) return noSend('deferred', 'preflight-expired');
      timer = setTimeout(() => controller.abort(), remaining);
      let privateBinding: PrivateChannelMaterial;
      try {
        settled = false;
        const loading = this.bindings.get(root, prepared.bound.id);
        active = loading;
        void loading.finally(() => { settled = true; }).catch(() => undefined);
        privateBinding = await untilAborted(loading, controller.signal);
      } catch {
        if (keys.some(key => this.#cancelled.has(key))) return noSend('cancelled', 'cancelled-before-readiness');
        if (controller.signal.aborted || this.bots.now() >= expiresUtc) return noSend('deferred', 'preflight-expired');
        return noSend('unavailable', 'private-runtime-binding-unavailable');
      }
      if (keys.some(key => this.#cancelled.has(key))) return noSend('cancelled', 'cancelled-before-readiness');
      if (controller.signal.aborted || this.bots.now() >= expiresUtc) return noSend('deferred', 'preflight-expired');
      let ready: { status: 'ready' | 'unavailable' | 'deferred' };
      try {
        settled = false;
        active = this.port.preflight({ root, material: privateBinding, deliveryIds: ids, signal: controller.signal });
        void active.finally(() => { settled = true; }).catch(() => undefined);
        ready = object(await untilAborted(active, controller.signal), ['status']) as typeof ready;
        requireThat(['ready', 'unavailable', 'deferred'].includes(ready.status), 'channel-preflight', 'Preflight must report a bounded no-send state.');
      } catch {
        if (keys.some(key => this.#cancelled.has(key))) return noSend('cancelled', 'preflight-did-not-submit');
        return controller.signal.aborted || this.bots.now() >= expiresUtc
          ? noSend('deferred', 'preflight-expired') : noSend('unavailable', 'preflight-did-not-submit');
      }
      if (ready.status !== 'ready') return noSend(ready.status, 'preflight-did-not-submit');
      const sending = await this.bots.repository.transaction(async tx => {
        const current = findRoot(tx, root);
        if (binding(current)?.frame_hash !== prepared.bound.frame.frame_hash) return { reason: 'authority-changed', attempt: null };
        const bound = this.#binding(current);
        const now = this.bots.now();
        if (now >= expiresUtc) return { reason: 'preflight-expired', attempt: null };
        const reason = this.#eligibility(current, ids, bound, now);
        if (reason || controller.signal.aborted) return { reason: reason ?? (keys.some(key => this.#cancelled.has(key)) ? 'cancelled' : 'preflight-expired'), attempt: null };
        if (!ids.every(id => this.#preflight(current, id)?.frame_hash === prepared.frame.frame_hash)) return { reason: 'generation-changed', attempt: null };
        if (ids.some(id => this.#status(current, id) !== 'pending')) return { reason: 'already-settled', attempt: null };
        const queues = memoryFrames(current).filter(f => ids.includes(f.frame_hash));
        const message = queues.map(f => referenceRecap(current, workEvent(f.payload).data).summary).join('\n\n');
        if (Buffer.byteLength(message, 'utf8') > 8_192) return { reason: 'message-byte-bound', attempt: null };
        const attempt = await this.bots.appendEvent(tx, current, 'channel.attempt', {
          deliveryIds: ids, bindingWave: bound.frame.frame_hash, preflight: prepared.frame.frame_hash,
          generation: workEvent(prepared.frame.payload).data.generation!,
        }, `send-${prepared.frame.frame_hash}`);
        return { reason: null, attempt, text: message };
      });
      if (!sending.attempt) return noSend(sending.reason === 'cancelled' ? 'cancelled' : 'deferred', sending.reason!);
      let status = 'not-submitted', receipt: string | null = null;
      if (!controller.signal.aborted && !keys.some(key => this.#cancelled.has(key)) && this.bots.now() < expiresUtc) {
        try {
          settled = false;
          active = this.port.send({ root, ...privateBinding, deliveryId: sending.attempt.frame_hash, text: sending.text!, signal: controller.signal });
          void active.finally(() => { settled = true; }).catch(() => undefined);
          const result = object(await untilAborted(active, controller.signal), ['receipt']);
          requireThat(typeof result.receipt === 'string' && /^[A-Za-z0-9._:-]{1,200}$/u.test(result.receipt),
            'channel-receipt', 'Only an opaque bounded delivery receipt may be persisted.');
          receipt = result.receipt; status = 'delivered';
        } catch { status = 'uncertain'; }
      }
      await this.bots.repository.transaction(async tx => this.bots.appendEvent(tx, findRoot(tx, root), 'channel.outcome', {
        channel: 'imessage', deliveryIds: ids, attempt: sending.attempt!.frame_hash,
        preflight: prepared.frame.frame_hash, status, receipt, submitted: status !== 'not-submitted',
      }, `delivery-${sending.attempt.frame_hash}`));
      return { status, deliveryIds: ids, receipt, preflight: prepared.frame.frame_hash,
        generation: workEvent(prepared.frame.payload).data.generation!, replayed: false };
    } finally {
      if (timer) clearTimeout(timer);
      if (active && !settled) void active.finally(cleanup).catch(() => undefined);
      else cleanup();
    }
  }

  async cancel(root: string, deliveryId: string, operationId: string): Promise<JsonObject> {
    wave(deliveryId);
    const key = `${root}:${deliveryId}`;
    this.#cancelled.add(key);
    this.#inflight.get(key)?.abort();
    const frame = await this.bots.repository.transaction(async tx => {
      const current = findRoot(tx, root);
      requireThat(memoryFrames(current).some(f => f.frame_hash === deliveryId && f.payload.event === 'channel.queued'),
        'channel-delivery', 'Cancel an exact existing queued occurrence, not a guessed identity.');
      return this.bots.appendEvent(tx, current, 'channel.cancelled', { deliveryId, actor: 'local-operator' }, operationId);
    });
    return { root, deliveryId, source: frame.frame_hash, cancelledForFutureDispatch: true, irreversibleEffectsRecalled: false };
  }

  async recap(root: string): Promise<JsonObject> {
    const snapshot = await this.bots.repository.root(root);
    assertCanonicalSelection(snapshot);
    const frames = memoryFrames(snapshot);
    const queues = frames.filter(f => f.payload.event === 'channel.queued');
    const reviewed = new Set(frames.filter(f => f.payload.event === 'channel.inbound.reviewed').map(f => workEvent(f.payload).data.sourceWave));
    return { channel: 'imessage', transportAvailable: this.port.available,
      inbox: frames.filter(f => f.payload.event === 'turn.user' && workEvent(f.payload).data.origin === 'external-imessage'
        && !reviewed.has(f.frame_hash)).map(f => ({ source: sourceReference(f), text: workEvent(f.payload).data.text!, attribution: turnAttribution(f) })),
      resolvedQuestions: queues.filter(f => this.#status(snapshot, f.frame_hash) === 'resolved').map(f => f.frame_hash),
      pending: queues.filter(f => !['delivered', 'cancelled', 'resolved'].includes(this.#status(snapshot, f.frame_hash))).map(f => {
        const preflight = this.#preflight(snapshot, f.frame_hash);
        const outcome = preflight && memoryFrames(snapshot).find(o => workEvent(o.payload).data.preflight === preflight.frame_hash
          && (o.payload.event === 'channel.preflight.outcome' || (o.payload.event === 'channel.outcome' && workEvent(o.payload).data.status === 'not-submitted')));
        try { return { deliveryId: f.frame_hash, ...referenceRecap(snapshot, workEvent(f.payload).data), available: true,
          status: this.#status(snapshot, f.frame_hash), preflightGeneration: preflight ? workEvent(preflight.payload).data.generation! : 0,
          preflightOutcome: outcome ? workEvent(outcome.payload).data.status! : null }; }
        catch { return { deliveryId: f.frame_hash, summary: 'Original source work is unavailable; no copied recap is substituted.', sources: [], available: false }; }
      }), automaticReplay: false };
  }

  async receive(root: string, envelope: unknown): Promise<JsonObject> {
    requireThat(this.port.available, 'channel-disabled', 'The private transport is disabled.');
    const snapshot = await this.bots.repository.root(root);
    const selected = this.#binding(snapshot);
    requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'External input never restores a hidden root.');
    const privateBinding = await this.bindings.get(root, selected.id);
    const incoming = await this.port.verifyIncoming(envelope);
    object(incoming, ['contactRef', 'messageId', 'text']);
    const current = await this.bots.repository.root(root);
    requireThat(this.#binding(current).frame.frame_hash === selected.frame.frame_hash && privateBinding.contactRef === incoming.contactRef, 'channel-binding',
    'Only the explicitly bound local contact may feed this same root conversation.');
    return this.conversation.externalInbox(root, text(incoming.text, 4_000),
      `imessage-${contentHash({ root, bindingId: selected.id, messageId: text(incoming.messageId, 200) })}`, selected.frame.frame_hash);
  }

  async reviewInbound(root: string, sourceWave: string, operationId: string): Promise<JsonObject> {
    const frame = await this.bots.repository.transaction(async tx => {
      const current = findRoot(tx, root);
      requireThat(!projectBot(current).hidden, 'bot-hidden', 'Restore this root before reviewing external input.');
      const input = memoryFrames(current).find(f => f.frame_hash === sourceWave);
      requireThat(input?.payload.event === 'turn.user' && workEvent(input.payload).data.origin === 'external-imessage',
        'external-inbox', 'Review the exact external source without granting confirmation authority.');
      return this.bots.appendEvent(tx, current, 'channel.inbound.reviewed', { sourceWave, actor: 'local-operator' }, operationId);
    });
    return { root, receipt: sourceReference(frame), confirmationAccepted: false };
  }
}
