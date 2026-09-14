import { canonicalJson, contentHash, type JsonObject, type RappFrame } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { object, text, workEvent } from './contract.js';
import { Conversation, type ConversationResult } from './conversation.js';
import { Refusal, requireThat } from './errors.js';
import { wave } from './intent.js';
import { projectBot, publicWorkText } from './projection.js';
import type { RootSnapshot } from './repository.js';
import { memoryFrames, sourceReference } from './source-memory.js';

export interface PrivateChannelPort {
  readonly channel: 'imessage';
  readonly available: boolean;
  readonly idempotentDelivery: true;
  send(input: { root: string; contactRef: string; permissionRef: string; deliveryId: string; text: string }): Promise<{ receipt: string }>;
  verifyIncoming(envelope: unknown): Promise<{ contactRef: string; messageId: string; text: string }>;
}
export class DisabledIMessage implements PrivateChannelPort {
  readonly channel = 'imessage';
  readonly available = false;
  readonly idempotentDelivery = true;
  async send(): Promise<{ receipt: string }> {
    throw new Refusal('channel-disabled', 'Production iMessage is disabled until explicit local OS permission and contact binding are verified.');
  }
  async verifyIncoming(): Promise<never> { throw new Refusal('channel-disabled', 'No authenticated iMessage transport is active.'); }
}

function binding(root: RootSnapshot): RappFrame | undefined {
  return memoryFrames(root).filter(f => f.payload.event === 'channel.bound').at(-1);
}

export function referenceRecap(root: RootSnapshot, queued: JsonObject): { summary: string; sources: JsonObject[] } {
  if (queued.format !== 'rapp-work.recap-references/1') {
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
    const value = event.event === 'client.conversation' ? object(event.data.content).text
      : event.event === 'collaboration.synthesized' ? publicWorkText(frame) : event.data.text ?? event.data.summary;
    return `[${event.scope}] ${event.event}: ${String(value ?? 'Recorded source outcome').slice(0, 260)}`;
  }).join('\n') : `${root.definition.name}: no completed source work is referenced.`;
  return { summary, sources: refs.map(value => object(value)) };
}

export class PrivateChannels {
  constructor(readonly bots: Bots, readonly conversation: Conversation, readonly port: PrivateChannelPort = new DisabledIMessage()) {}

  async bind(root: string, contactRef: string, permissionRef: string, enabled: boolean, operationId: string): Promise<JsonObject> {
    wave(contactRef);
    wave(permissionRef);
    requireThat(typeof enabled === 'boolean', 'channel-binding', 'A local operator must explicitly enable or disable the contact binding.');
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before binding a private channel.');
      const frame = await this.bots.appendEvent(transaction, snapshot, 'channel.bound',
        { channel: 'imessage', contactRef, permissionRef, enabled, scope: 'conversation-and-public-recaps', actor: 'local-operator' }, operationId);
      return { root, source: frame.frame_hash, transportEnabled: this.port.available && enabled,
        productionPermissionVerifiedByThisCommand: false };
    });
  }

  async queueRecap(root: string, operationId: string): Promise<JsonObject> {
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      const projection = projectBot(snapshot);
      const selected = binding(snapshot);
      requireThat(!projection.hidden && selected && workEvent(selected.payload).data.enabled === true,
        'channel-binding', 'An explicit current root/contact/permission binding is required.');
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(duplicate.payload.event === 'channel.queued', 'idempotency-conflict', 'This request ID is already used.');
        return { deliveryId: duplicate.frame_hash, ...referenceRecap(snapshot, workEvent(duplicate.payload).data) };
      }
      const meaningful = memoryFrames(snapshot).filter(f =>
        ['turn.assistant', 'client.conversation', 'work.progress', 'routine.tick', 'organization.applied', 'collaboration.synthesized'].includes(String(f.payload.event))).slice(-6);
      const frame = await this.bots.appendEvent(transaction, snapshot, 'channel.queued', {
        channel: 'imessage', bindingWave: selected.frame_hash, contactRef: workEvent(selected.payload).data.contactRef!,
        permissionRef: workEvent(selected.payload).data.permissionRef!,
        format: 'rapp-work.recap-references/1', sourceRefs: meaningful.map(sourceReference),
      }, operationId);
      return { deliveryId: frame.frame_hash, ...referenceRecap(snapshot, workEvent(frame.payload).data) };
    });
  }

  async deliver(root: string, deliveryId: string, operationId: string): Promise<JsonObject> {
    const prepared = await this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Hidden roots do not send private-channel messages.');
      const queue = memoryFrames(snapshot).find(f => f.frame_hash === deliveryId && f.payload.event === 'channel.queued');
      const selected = binding(snapshot);
      requireThat(queue && selected && workEvent(selected.payload).data.enabled === true
        && workEvent(queue.payload).data.bindingWave === selected.frame_hash, 'channel-binding',
      'Delivery must match the exact current root, permission and contact binding.');
      const completed = memoryFrames(snapshot).find(f => f.payload.event === 'channel.outcome'
        && workEvent(f.payload).data.deliveryId === deliveryId && workEvent(f.payload).data.status === 'delivered');
      if (completed) return { queued: workEvent(queue.payload).data, attempt: completed, send: false };
      const duplicate = memoryFrames(snapshot).find(f => f.payload.operationId === operationId);
      if (duplicate) {
        requireThat(duplicate.payload.event === 'channel.attempt' && workEvent(duplicate.payload).data.deliveryId === deliveryId,
          'idempotency-conflict', 'This delivery attempt ID is already bound.');
        return { queued: workEvent(queue.payload).data, attempt: duplicate, send: false };
      }
      const attempt = await this.bots.appendEvent(transaction, snapshot, 'channel.attempt',
        { deliveryId, bindingWave: selected.frame_hash }, operationId);
      return { queued: workEvent(queue.payload).data, attempt, send: true };
    });
    if (!prepared.send) return { status: 'already-recorded-or-uncertain', replayed: false, deliveryId };
    let status = 'unavailable';
    let receipt: string | null = null;
    if (this.port.available && this.port.idempotentDelivery) {
      try {
        const current = await this.bots.repository.root(root);
        requireThat(!projectBot(current).hidden && binding(current)?.frame_hash === prepared.queued.bindingWave,
          'channel-binding', 'Private-channel authority changed before dispatch.');
        const result = await this.port.send({
          root, deliveryId, contactRef: String(prepared.queued.contactRef), permissionRef: String(prepared.queued.permissionRef),
          text: referenceRecap(current, prepared.queued).summary,
        });
        requireThat(/^[A-Za-z0-9._:-]{1,200}$/u.test(result.receipt), 'channel-receipt', 'Only an opaque bounded delivery receipt may be persisted.');
        receipt = result.receipt;
        status = 'delivered';
      } catch { status = 'uncertain'; }
    }
    await this.bots.repository.transaction(async transaction => {
      await this.bots.appendEvent(transaction, findRoot(transaction, root), 'channel.outcome',
        { channel: 'imessage', deliveryId, attempt: prepared.attempt.frame_hash, status, receipt },
        `delivery-${prepared.attempt.frame_hash}`);
    });
    return { status, deliveryId, receipt, replayed: false };
  }

  async recap(root: string): Promise<JsonObject> {
    const snapshot = await this.bots.repository.root(root);
    const queued = memoryFrames(snapshot).filter(f => f.payload.event === 'channel.queued');
    const delivered = new Set(memoryFrames(snapshot).filter(f => f.payload.event === 'channel.outcome'
      && workEvent(f.payload).data.status === 'delivered').map(f => workEvent(f.payload).data.deliveryId));
    return {
      channel: 'imessage', transportAvailable: this.port.available,
      pending: queued.filter(f => !delivered.has(f.frame_hash)).map(f => {
        try { return { deliveryId: f.frame_hash, ...referenceRecap(snapshot, workEvent(f.payload).data), available: true }; }
        catch { return { deliveryId: f.frame_hash, summary: 'Original source work is unavailable; no copied recap is substituted.', sources: [], available: false }; }
      }),
      automaticReplay: false,
    };
  }

  async receive(root: string, envelope: unknown): Promise<ConversationResult> {
    requireThat(this.port.available, 'channel-disabled', 'The private transport is disabled.');
    const incoming = await this.port.verifyIncoming(envelope);
    object(incoming, ['contactRef', 'messageId', 'text']);
    const snapshot = await this.bots.repository.root(root);
    const selected = binding(snapshot);
    requireThat(selected && workEvent(selected.payload).data.enabled === true
      && workEvent(selected.payload).data.contactRef === incoming.contactRef, 'channel-binding',
    'Only the explicitly bound local contact may feed this same root conversation.');
    return this.conversation.converse(root, text(incoming.text),
      `imessage-${contentHash({ contact: incoming.contactRef, messageId: text(incoming.messageId, 200) })}`);
  }
}
