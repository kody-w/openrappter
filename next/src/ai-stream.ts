import { randomUUID } from 'node:crypto';
import { canonicalJson, snapshotJson, type JsonObject } from './canonical.js';
import { AI_LIMITS } from './ai-contract.js';
import { AiProjectionApi } from './ai-api.js';
import { atCursor, cursorFor, projectAi } from './ai-projector.js';
import { Refusal, requireThat } from './errors.js';
import { memoryAdvance, memoryFrames, memoryPending } from './source-memory.js';

export interface ProjectionEvent extends JsonObject {
  schema: 'rapp-work.projection-event/1';
  subscription: string;
  type: 'snapshot' | 'update' | 'resync-required';
  cursor: JsonObject | null;
  previous: JsonObject | null;
  snapshot: JsonObject | null;
  reason: string | null;
  replay: boolean;
}
interface Subscription {
  id: string;
  root: string;
  capability: string;
  scope: string;
  queuedCursor: JsonObject | null;
  deliveredCursor: JsonObject | null;
  queue: ProjectionEvent[];
  bytes: number;
  expires: number;
  closed: boolean;
  initialFrames: ReadonlySet<string>;
}
export interface StreamOptions { queuedEvents?: number; queuedBytes?: number; replayEvents?: number; clock?: () => number }

export class ProjectionStreams {
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #queueLimit: number;
  readonly #byteLimit: number;
  readonly #replayLimit: number;
  readonly #clock: () => number;
  #polling: Promise<void> | null = null;
  constructor(readonly api: AiProjectionApi, options: StreamOptions = {}) {
    this.#queueLimit = options.queuedEvents ?? AI_LIMITS.queuedEvents;
    this.#byteLimit = options.queuedBytes ?? AI_LIMITS.queuedBytes;
    this.#replayLimit = options.replayEvents ?? AI_LIMITS.replayEvents;
    this.#clock = options.clock ?? Date.now;
    requireThat(Number.isInteger(this.#queueLimit) && this.#queueLimit > 0 && this.#queueLimit <= AI_LIMITS.queuedEvents
      && Number.isInteger(this.#byteLimit) && this.#byteLimit >= 1_024 && this.#byteLimit <= AI_LIMITS.queuedBytes
      && Number.isInteger(this.#replayLimit) && this.#replayLimit > 0 && this.#replayLimit <= AI_LIMITS.replayEvents,
    'stream-bounds', 'A stream may narrow, never expand, the hard event/byte/replay bounds.');
  }

  async subscribe(root: string, capability: string, cursor: unknown = null): Promise<JsonObject> {
    requireThat(this.#subscriptions.size < AI_LIMITS.subscriptions, 'subscription-limit', 'The bounded subscription limit is reached.');
    const selected = await this.api.authority.authorize(root, capability, ['projection.read', 'projection.subscribe']);
    const base = cursor === null ? selected.root : atCursor(selected.root, cursor);
    requireThat(memoryFrames(selected.root).length - memoryFrames(base).length <= this.#replayLimit,
      'resync-required', 'The reconnect gap exceeds the replay window; request a fresh snapshot and page retained history explicitly.');
    const projection = projectAi(base, selected.grant.data.scope);
    requireThat(this.#subscriptions.size < AI_LIMITS.subscriptions, 'subscription-limit', 'The bounded subscription limit is reached.');
    const id = randomUUID();
    const source = cursorFor(base);
    const subscription: Subscription = {
      id, root, capability, scope: selected.grant.data.scope, queuedCursor: source, deliveredCursor: source,
      queue: [], bytes: 0, expires: this.#clock() + AI_LIMITS.subscriptionMs, closed: false,
      initialFrames: new Set(memoryFrames(selected.root).map(f => f.frame_hash)),
    };
    this.#subscriptions.set(id, subscription);
    this.#enqueue(subscription, { schema: 'rapp-work.projection-event/1', subscription: id, type: 'snapshot',
      cursor: source, previous: null, snapshot: projection, reason: null, replay: cursor !== null });
    return { subscription: id, root, cursor: source, replayPending: memoryFrames(base).length < memoryFrames(selected.root).length,
      limits: { events: this.#queueLimit, bytes: this.#byteLimit, replay: this.#replayLimit, lifetimeMs: AI_LIMITS.subscriptionMs } };
  }

  #enqueue(subscription: Subscription, event: ProjectionEvent): boolean {
    const bytes = Buffer.byteLength(canonicalJson(event));
    if (subscription.queue.length >= this.#queueLimit || subscription.bytes + bytes > this.#byteLimit) {
      this.#close(subscription, 'backpressure');
      return false;
    }
    subscription.queue.push(snapshotJson(event) as ProjectionEvent);
    subscription.bytes += bytes;
    subscription.queuedCursor = event.cursor;
    return true;
  }

  #close(subscription: Subscription, reason: string): void {
    if (subscription.closed) return;
    subscription.closed = true;
    const terminal: ProjectionEvent = {
      schema: 'rapp-work.projection-event/1', subscription: subscription.id, type: 'resync-required',
      cursor: subscription.deliveredCursor, previous: subscription.deliveredCursor,
      snapshot: null, reason, replay: false,
    };
    subscription.queue = [terminal];
    subscription.bytes = Buffer.byteLength(canonicalJson(terminal));
  }

  async poll(): Promise<void> {
    if (this.#polling) return this.#polling;
    this.#polling = this.#refresh();
    try { await this.#polling; } finally { this.#polling = null; }
  }
  async #refresh(): Promise<void> {
    for (const subscription of [...this.#subscriptions.values()]) {
      if (subscription.closed) continue;
      if (this.#clock() >= subscription.expires) { this.#close(subscription, 'subscription-expired'); continue; }
      try {
        const selected = await this.api.authority.authorize(subscription.root, subscription.capability, ['projection.read', 'projection.subscribe']);
        const prefix = atCursor(selected.root, subscription.queuedCursor);
        const pending = memoryPending(selected.root, prefix);
        if (pending.length > this.#replayLimit) { this.#close(subscription, 'replay-window-exceeded'); continue; }
        if (pending.length && subscription.queue.length >= this.#queueLimit) { this.#close(subscription, 'backpressure'); continue; }
        const room = this.#queueLimit - subscription.queue.length;
        for (const [offset, frame] of pending.slice(0, room).entries()) {
          const previous = subscription.queuedCursor;
          const state = memoryAdvance(selected.root, prefix, offset + 1);
          const cursor = cursorFor(state);
          const snapshot = projectAi(state, subscription.scope);
          if (!this.#enqueue(subscription, { schema: 'rapp-work.projection-event/1', subscription: subscription.id,
            type: 'update', cursor, previous, snapshot, reason: null, replay: subscription.initialFrames.has(frame.frame_hash) })) break;
        }
        if (!pending.length && canonicalJson(cursorFor(selected.root)) !== canonicalJson(subscription.queuedCursor)) {
          this.#enqueue(subscription, { schema: 'rapp-work.projection-event/1', subscription: subscription.id,
            type: 'update', cursor: cursorFor(selected.root), previous: subscription.queuedCursor,
            snapshot: projectAi(selected.root, subscription.scope), reason: 'retained-source-branches-changed', replay: false });
        }
      } catch (error) {
        this.#close(subscription, error instanceof Refusal && ['cursor-invalid', 'projection-size'].includes(error.code)
          ? error.code : 'authority-ended');
      }
    }
  }

  async take(id: string, count = 1): Promise<ProjectionEvent[]> {
    requireThat(Number.isInteger(count) && count >= 1 && count <= this.#queueLimit, 'stream-bounds', 'Drain only a bounded number of events.');
    const subscription = this.#subscriptions.get(id);
    requireThat(subscription, 'subscription-not-found', 'This disposable subscription is unavailable; reconnect from a canonical cursor.');
    if (this.#clock() >= subscription.expires) this.#close(subscription, 'subscription-expired');
    if (!subscription.closed) {
      try { await this.api.authority.authorize(subscription.root, subscription.capability, ['projection.read', 'projection.subscribe']); }
      catch { this.#close(subscription, 'authority-ended'); }
    }
    const events = subscription.queue.splice(0, count);
    for (const event of events) {
      subscription.bytes -= Buffer.byteLength(canonicalJson(event));
      if (event.type !== 'resync-required') subscription.deliveredCursor = event.cursor;
    }
    if (subscription.closed && subscription.queue.length === 0) this.#subscriptions.delete(id);
    return events;
  }

  status(id: string): JsonObject {
    const subscription = this.#subscriptions.get(id);
    requireThat(subscription, 'subscription-not-found', 'No such disposable subscription.');
    return { root: subscription.root, events: subscription.queue.length, bytes: subscription.bytes,
      closed: subscription.closed, deliveredCursor: subscription.deliveredCursor, queuedCursor: subscription.queuedCursor };
  }
  unsubscribe(id: string): void { this.#subscriptions.delete(id); }
  close(): void { this.#subscriptions.clear(); }
}
