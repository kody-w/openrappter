import type { Readable } from 'node:stream';
import { canonicalJson, parseJson, type JsonObject } from './canonical.js';
import { label, list, object, text } from './contract.js';
import { publicError, Refusal, requireThat } from './errors.js';
import { BoundedWriter, boundedLines } from './bounded-stdio.js';
import { AI_LIMITS, AI_PROJECTION_SCHEMA } from './ai-contract.js';
import { MigrationService } from './migration.js';

export const MIGRATION_METHODS = Object.freeze([
  'rapp_work_migration_read', 'rapp_work_migration_subscribe', 'rapp_work_migration_begin',
  'rapp_work_migration_start_batch', 'rapp_work_migration_stage', 'rapp_work_migration_prepare',
  'rapp_work_migration_commit', 'rapp_work_migration_rollback', 'rapp_work_migration_finish',
]);
export class MigrationEndpoint {
  #subscribed = false;
  #lastCursor: string | null = null;
  #polling: Promise<void> | null = null;
  readonly #recent: number[] = [];
  constructor(readonly migration: MigrationService, readonly capability: string, readonly send: (value: unknown) => void) {}

  async handle(line: string): Promise<void> {
    const now = Date.now();
    while (this.#recent[0] !== undefined && this.#recent[0] <= now - 60_000) this.#recent.shift();
    requireThat(this.#recent.length < 600, 'migration-rate', 'The bounded migration connection rate is exhausted.');
    this.#recent.push(now);
    let id: string | null = null;
    try {
      const request = object(parseJson(line), ['id', 'method', 'params']);
      id = label(request.id);
      const p = object(request.params);
      this.migration.authenticate(p.root, this.capability);
      const exact = (fields: string[], optional: string[] = []): void => { object(p, ['root', ...fields], optional); };
      const method = text(request.method, 80);
      let result: unknown;
      switch (method) {
        case 'rapp_work_migration_read':
          exact([]);
          result = await this.migration.projection();
          break;
        case 'rapp_work_migration_subscribe': {
          exact([], ['cursorHash']);
          const projection = await this.migration.projection();
          requireThat(p.cursorHash === undefined || p.cursorHash === projection.cursorHash,
            'migration-resync-required', 'The estate cursor changed; read a fresh canonical projection before reconnecting.');
          this.#subscribed = true;
          this.#lastCursor = null;
          result = { subscribed: true, cursorHash: projection.cursorHash, mode: 'passive-estate-projection' };
          break;
        }
        case 'rapp_work_migration_begin':
          exact([]);
          result = await this.migration.begin(id);
          break;
        case 'rapp_work_migration_start_batch':
          exact(['batch', 'items']);
          result = await this.migration.startBatch(label(p.batch), list(p.items, 256).map(label), id);
          break;
        case 'rapp_work_migration_stage':
          exact(['stage']);
          result = await this.migration.stage(p.stage, id);
          break;
        case 'rapp_work_migration_prepare':
          exact(['batch', 'item']);
          result = await this.migration.prepare(label(p.batch), label(p.item), id);
          break;
        case 'rapp_work_migration_commit':
          exact(['batch', 'item']);
          result = await this.migration.commit(label(p.batch), label(p.item));
          break;
        case 'rapp_work_migration_rollback':
          exact(['batch', 'reason']);
          result = await this.migration.rollback(label(p.batch), text(p.reason, 500), id);
          break;
        case 'rapp_work_migration_finish': {
          exact([]);
          result = await this.migration.finish();
          break;
        }
        default: throw new Refusal('method-unavailable', 'Only the explicit owner-approved migration API is exposed; no shell, source write, delete or live-adoption shortcut exists.');
      }
      this.send({ interface: AI_PROJECTION_SCHEMA, id, result });
    } catch (error) { this.send({ interface: AI_PROJECTION_SCHEMA, id, error: publicError(error) }); }
  }
  async poll(): Promise<void> {
    if (!this.#subscribed) return;
    if (this.#polling) return this.#polling;
    this.#polling = (async () => {
      const snapshot = await this.migration.projection();
      if (!this.#subscribed) return;
      if (snapshot.cursorHash === this.#lastCursor) return;
      const previous = this.#lastCursor;
      this.#lastCursor = String(snapshot.cursorHash);
      this.send({ interface: AI_PROJECTION_SCHEMA, event: {
        schema: 'rapp-work.migration-event/1', type: previous === null ? 'snapshot' : 'update',
        root: this.migration.plan.owner, cursorHash: snapshot.cursorHash, previousCursorHash: previous,
        cursor: snapshot.cursor, snapshot,
      } });
    })();
    try { await this.#polling; } finally { this.#polling = null; }
  }
  async close(): Promise<void> {
    this.#subscribed = false;
    if (this.#polling) await this.#polling;
  }
}

export async function serveMigration(endpoint: MigrationEndpoint, input: Readable, writer: BoundedWriter): Promise<void> {
  let failed: unknown = null;
  const timer = setInterval(() => { void endpoint.poll().catch(error => { failed = error; input.destroy(); }); }, AI_LIMITS.pollMs);
  try {
    for await (const line of boundedLines(input)) {
      await endpoint.handle(line);
      await endpoint.poll();
      if (failed) throw failed;
    }
    await writer.flush();
  } finally { clearInterval(timer); await endpoint.close(); }
}

export function migrationDisplay(snapshot: JsonObject): JsonObject {
  const roots = snapshot.roots as JsonObject[];
  const items = snapshot.imported as JsonObject[];
  return {
    root: snapshot.root!, cursorHash: snapshot.cursorHash!, counts: snapshot.counts!, complete: snapshot.complete!,
    roots: roots.map(root => ({ root: root.root!, name: root.name!, hidden: root.hidden!,
      scopes: (root.scopes as JsonObject[]).map(s => ({ id: s.id!, parent: s.parent!, name: s.name!, kind: s.kind! })),
      branches: root.branches!, artifacts: root.artifacts! })),
    items: items.map(item => ({ id: item.id!, title: item.title!, root: item.root!, kind: item.kind!,
      classification: item.classification!, provider: item.provider!, sourceIdentity: item.sourceIdentity! })),
    batches: snapshot.batches!,
    canonicalProjectionHash: canonicalJson({ cursor: snapshot.cursor!, counts: snapshot.counts! }),
  };
}
