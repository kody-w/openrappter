import { timingSafeEqual } from 'node:crypto';
import { canonicalJson, contentHash, sha256, type JsonObject, type RappFrame } from './canonical.js';
import { Bots } from './bots.js';
import { eventPayload, label, list, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { reference, projectBot } from './projection.js';
import type { MigrationTransaction, RootSnapshot } from './repository.js';
import {
  requireMigrationAuthority, type BoundMigrationAuthority,
} from './migration-authority.js';
import {
  MIGRATION_LIMITS, migrationPlan, verifyFileTable, verifyRootFiles,
  type MigrationItem, type MigrationPlan,
} from './migration-contract.js';
import { memoryFrames, memoryHeadHashes, sourceChain, sourceReference } from './source-memory.js';

interface Batch { id: string; items: string[]; aborted: boolean }
interface ControlState {
  bound: boolean;
  batches: Map<string, Batch>;
  chunks: Map<string, Map<number, Buffer>>;
  pointers: Set<string>;
  prepared: Map<string, RappFrame>;
}
const batchItem = (batch: string, item: string): string => `${batch}/${item}`;
const pieceKey = (batch: string, item: string, path: string): string => `${batch}/${item}/${path}`;
const controlSchema = 'rapp-work.migration-control/1';

function controls(frames: readonly RappFrame[], plan: MigrationPlan, authorityHash: string): ControlState {
  const state: ControlState = { bound: false, batches: new Map(), chunks: new Map(), pointers: new Set(), prepared: new Map() };
  for (const frame of frames) {
    const p = object(frame.payload, ['schema', 'owner', 'planHash', 'event', 'operationId', 'data']);
    requireThat(p.schema === controlSchema && p.owner === plan.owner && p.planHash === contentHash(plan),
      'migration-plan-binding', 'An isolated migration profile cannot be rebound to a different source selection.');
    label(p.operationId);
    const data = object(p.data);
    if (p.event === 'plan.bound') {
      requireThat(!state.bound && frame.seq === 0 && data.authorityHash === authorityHash,
        'migration-plan-binding', 'Bind an empty profile once to the exact prevalidated authority.');
      state.bound = true;
    } else {
      requireThat(state.bound, 'migration-plan-binding', 'The isolated profile has no canonical migration binding.');
      if (p.event === 'batch.started') {
        const id = label(data.batch);
        requireThat(!state.batches.has(id), 'migration-batch', 'A batch is immutable once started.');
        state.batches.set(id, { id, items: list(data.items, MIGRATION_LIMITS.items).map(label), aborted: false });
      } else {
        const batch = state.batches.get(String(data.batch));
        requireThat(batch, 'migration-batch', 'A staged operation has no selected batch.');
        if (p.event === 'batch.rolledback') batch.aborted = true;
        else {
          requireThat(!batch.aborted && batch.items.includes(String(data.item)), 'migration-batch', 'A rolled-back or unselected item cannot progress.');
          if (p.event === 'chunk.staged') {
            const key = pieceKey(batch.id, String(data.item), String(data.path));
            const parts = state.chunks.get(key) ?? new Map();
            const bytes = Buffer.from(String(data.base64), 'base64');
            requireThat(bytes.toString('base64') === data.base64 && sha256(bytes) === data.sha256 && !parts.has(Number(data.index)),
              'migration-chunk', 'Staged canonical chunks must be exact and unique.');
            parts.set(Number(data.index), bytes); state.chunks.set(key, parts);
          } else if (p.event === 'pointer.staged') state.pointers.add(batchItem(batch.id, String(data.item)));
          else if (p.event === 'commit.prepared') state.prepared.set(batchItem(batch.id, String(data.item)), frame);
          else requireThat(false, 'migration-control', 'Unknown migration control event.');
        }
      }
    }
  }
  return state;
}

export interface MigrationOptions {
  plan: MigrationPlan;
  authority: BoundMigrationAuthority;
  capabilityHash: string;
}

export class MigrationService {
  readonly plan: MigrationPlan;
  readonly planHash: string;
  readonly authorityHash: string;
  readonly approval: RappFrame;
  readonly authority: BoundMigrationAuthority;
  readonly #options: MigrationOptions;
  constructor(readonly bots: Bots, options: MigrationOptions) {
    this.plan = migrationPlan(options.plan);
    this.planHash = contentHash(this.plan);
    this.authority = requireMigrationAuthority(options.authority, this.plan);
    this.authorityHash = contentHash(this.authority.evidence);
    this.approval = this.authority.approval;
    requireThat(this.authority.signers.every(entry => this.bots.signer(entry.root) === entry.signer),
      'migration-signer-authority', 'The migration runtime does not hold the exact prevalidated signer set.');
    requireThat(/^[0-9a-f]{64}$/u.test(options.capabilityHash), 'migration-authority', 'An out-of-band migration capability commitment is required.');
    this.#options = options;
  }

  authenticate(root: unknown, capability: string): void {
    requireThat(root === this.plan.owner && typeof capability === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(capability)
      && timingSafeEqual(Buffer.from(sha256(capability), 'hex'), Buffer.from(this.#options.capabilityHash, 'hex')),
    'migration-unauthorized', 'The exact selected owner root and independently supplied migration capability are required.');
  }
  #item(id: unknown): MigrationItem {
    const item = this.plan.items.find(i => i.id === id);
    requireThat(item, 'migration-selection', 'An item outside the complete approved source selection is refused.');
    return item;
  }
  #batch(state: ControlState, batch: unknown, item?: string): Batch {
    const selected = state.batches.get(label(batch));
    requireThat(selected && !selected.aborted && (item === undefined || selected.items.includes(item)),
      'migration-batch', 'Choose an active approved batch; aborted batches cannot be replayed.');
    return selected;
  }
  #receipt(root: RootSnapshot | undefined, item: MigrationItem): RappFrame | undefined {
    return root && memoryFrames(root).find(frame => ['migration.root.imported', 'migration.pointer.imported'].includes(String(frame.payload.event))
      && workEvent(frame.payload).data.planHash === this.planHash && workEvent(frame.payload).data.item === item.id);
  }
  #files(state: ControlState, batch: string, item: MigrationItem): Map<string, Buffer> {
    const files = new Map<string, Buffer>();
    for (const descriptor of item.files) {
      const parts = state.chunks.get(pieceKey(batch, item.id, descriptor.path)) ?? new Map();
      const count = Math.ceil(descriptor.bytes / MIGRATION_LIMITS.chunkBytes);
      requireThat(parts.size === count && Array.from({ length: count }, (_, i) => parts.has(i)).every(Boolean),
        'migration-incomplete', 'The full approved root closure has not arrived; do not materialize a partial world.');
      files.set(descriptor.path, Buffer.concat(Array.from({ length: count }, (_, i) => parts.get(i)!)));
    }
    verifyFileTable(item, files);
    return files;
  }
  async #control(tx: MigrationTransaction, event: string, data: JsonObject, operationId: string): Promise<RappFrame> {
    const payload = { schema: controlSchema, owner: this.plan.owner, planHash: this.planHash, event, operationId, data };
    const previous = tx.ledger.find(frame => frame.payload.operationId === operationId);
    if (previous) {
      requireThat(canonicalJson(previous.payload) === canonicalJson(payload), 'idempotency-conflict', 'The migration operation ID already records different work.');
      return previous;
    }
    return tx.appendControl(payload, this.bots.now());
  }
  async #transaction<T>(work: (tx: MigrationTransaction, state: ControlState) => Promise<T>): Promise<T> {
    const signer = this.bots.signer(this.plan.owner);
    requireThat(signer, 'migration-authority', 'The approved migration owner signer is unavailable.');
    return this.bots.repository.migrationTransaction(this.plan.owner, signer,
      tx => work(tx, controls(tx.ledger, this.plan, this.authorityHash)));
  }

  async begin(operationId: string): Promise<JsonObject> {
    return this.#transaction(async (tx, state) => {
      if (state.bound) return { bound: true, duplicate: true, source: reference(tx.ledger[0]!), planHash: this.planHash };
      requireThat(tx.snapshot.roots.length === 0 && tx.ledger.length === 0, 'migration-empty-profile', 'Migration starts only in an empty isolated greenfield profile.');
      const frame = await this.#control(tx, 'plan.bound', {
        approvalWave: this.approval.frame_hash, mode: this.plan.mode, selectedItems: this.plan.items.map(i => i.id),
        sourceRoots: this.plan.roots, profile: 'empty-isolated-profile', authorityHash: this.authorityHash,
      }, operationId);
      return { bound: true, duplicate: false, source: reference(frame), planHash: this.planHash };
    });
  }
  async startBatch(batch: string, items: string[], operationId: string): Promise<JsonObject> {
    label(batch);
    requireThat(items.length > 0 && items.length <= MIGRATION_LIMITS.items && new Set(items).size === items.length, 'migration-batch', 'Select a bounded unique canonical batch.');
    items.forEach(id => this.#item(id));
    return this.#transaction(async (tx, state) => {
      requireThat(state.bound, 'migration-plan-binding', 'Bind the approved plan before staging work.');
      const existing = state.batches.get(batch);
      requireThat(!existing?.aborted, 'migration-batch', 'A rolled-back batch cannot be resurrected.');
      if (existing) {
        requireThat(canonicalJson(existing.items) === canonicalJson(items), 'idempotency-conflict', 'A batch cannot change its selected items.');
        const original = tx.ledger.find(f => f.payload.event === 'batch.started' && object(f.payload.data).batch === batch)!;
        return { batch, duplicate: true, source: reference(original) };
      }
      const frame = await this.#control(tx, 'batch.started', { batch, items }, operationId);
      return { batch, source: reference(frame) };
    });
  }

  async stage(value: unknown, operationId: string): Promise<JsonObject> {
    const input = object(value, ['batch', 'item'], ['path', 'index', 'base64', 'pointer']);
    const item = this.#item(input.item);
    return this.#transaction(async (tx, state) => {
      const batch = this.#batch(state, input.batch, item.id);
      if (item.kind === 'estate-pointer') {
        object(input, ['batch', 'item', 'pointer']);
        requireThat(canonicalJson(input.pointer) === canonicalJson(item.pointer), 'migration-bytes', 'The selected native/historical pointer may not be rewritten.');
        const key = batchItem(batch.id, item.id);
        if (state.pointers.has(key)) return { staged: true, duplicate: true, item: item.id };
        const frame = await this.#control(tx, 'pointer.staged', { batch: batch.id, item: item.id, sourceDigest: item.sourceDigest }, operationId);
        return { staged: true, duplicate: false, item: item.id, source: reference(frame) };
      }
      object(input, ['batch', 'item', 'path', 'index', 'base64']);
      const file = item.files.find(f => f.path === input.path);
      requireThat(file && Number.isInteger(input.index) && Number(input.index) >= 0
        && Number(input.index) < Math.ceil(file.bytes / MIGRATION_LIMITS.chunkBytes), 'migration-chunk', 'Stage only an exact approved file/chunk index.');
      const bytes = Buffer.from(text(input.base64, 24_000), 'base64');
      const expected = Math.min(MIGRATION_LIMITS.chunkBytes, file.bytes - Number(input.index) * MIGRATION_LIMITS.chunkBytes);
      requireThat(bytes.toString('base64') === input.base64 && bytes.length === expected, 'migration-chunk', 'The bounded source chunk is not byte-exact.');
      const previous = state.chunks.get(pieceKey(batch.id, item.id, file.path))?.get(Number(input.index));
      if (previous) {
        requireThat(previous.equals(bytes), 'idempotency-conflict', 'A previously staged chunk may not be overwritten.');
        return { staged: true, duplicate: true, item: item.id, path: file.path, index: Number(input.index) };
      }
      const frame = await this.#control(tx, 'chunk.staged', { batch: batch.id, item: item.id, path: file.path,
        index: Number(input.index), base64: String(input.base64), sha256: sha256(bytes) }, operationId);
      return { staged: true, duplicate: false, item: item.id, path: file.path, index: Number(input.index), source: reference(frame) };
    });
  }

  async prepare(batchId: string, itemId: string, operationId: string): Promise<JsonObject> {
    const item = this.#item(itemId);
    return this.#transaction(async (tx, state) => {
      const batch = this.#batch(state, batchId, item.id);
      const receipt = this.#receipt(tx.snapshot.roots.find(r => r.definition.root === item.root), item);
      if (receipt) return { prepared: true, committed: true, duplicate: true, source: reference(receipt) };
      const previous = state.prepared.get(batchItem(batch.id, item.id));
      if (previous) return { prepared: true, duplicate: true, source: reference(previous) };
      if (item.kind === 'canonical-root') projectBot(verifyRootFiles(item.root, this.#files(state, batch.id, item), this.authority.signatures));
      else {
        requireThat(state.pointers.has(batchItem(batch.id, item.id)), 'migration-incomplete', 'Stage the approved pointer before preparing it.');
        const root = tx.snapshot.roots.find(r => r.definition.root === item.root);
        requireThat(root && projectBot(root).scopes.some(s => s.id === item.pointer!.scope),
          'migration-scope', 'The pointer needs its existing migrated canonical root and hidden scope.');
      }
      const frame = await this.#control(tx, 'commit.prepared', { batch: batch.id, item: item.id, sourceDigest: item.sourceDigest }, operationId);
      return { prepared: true, duplicate: false, source: reference(frame) };
    });
  }

  async commit(batchId: string, itemId: string): Promise<JsonObject> {
    const item = this.#item(itemId);
    return this.#transaction(async (tx, state) => {
      const batch = this.#batch(state, batchId, item.id);
      const root = tx.snapshot.roots.find(r => r.definition.root === item.root);
      const receipt = this.#receipt(root, item);
      if (receipt) return { committed: true, duplicate: true, item: item.id, source: reference(receipt) };
      const prepared = state.prepared.get(batchItem(batch.id, item.id));
      requireThat(prepared, 'migration-incomplete', 'A complete verified preparation is required before publication.');
      const data = { planHash: this.planHash, batch: batch.id, item: item.id, source: item, approvalWave: this.approval.frame_hash };
      const signer = this.bots.signer(item.root);
      requireThat(signer, 'migration-authority', 'The original root signer is required for a migration successor receipt.');
      const operationId = `migration-${contentHash({ plan: this.planHash, item: item.id })}`;
      if (item.kind === 'canonical-root') {
        requireThat(!root, 'migration-collision', 'Never overwrite or merge an existing destination root.');
        const files = this.#files(state, batch.id, item);
        const candidate = verifyRootFiles(item.root, files, this.authority.signatures);
        projectBot(candidate);
        const imported = await tx.materializeRoot(item.root, files, {
          root: item.root, family: 'memory', kind: 'memory.save', utc: prepared.utc, signer,
          expectedHead: candidate.streams.memory.at(-1)?.frame_hash ?? null,
          payload: { ...eventPayload(item.root, 'root', operationId, 'migration.root.imported', data),
            parents: [candidate.streams.body[0]!.frame_hash, ...memoryHeadHashes(candidate)] },
        }, contentHash({ plan: this.planHash, batch: batch.id, item: item.id }));
        return { committed: true, duplicate: false, item: item.id, root: item.root, source: reference(imported.streams.memory.at(-1)!) };
      }
      requireThat(root, 'migration-scope', 'The target root is unavailable.');
      requireThat(!projectBot(root).pointers.some(p => p.sourceIdentity === item.sourceIdentity),
        'migration-duplicate', 'This source pointer identity already exists; never normalize a duplicate into a new identity.');
      const frame = await tx.appendRoot({
        root: item.root, family: 'memory', kind: 'memory.save', utc: this.bots.now(), signer,
        expectedHead: sourceChain(root, String(item.pointer!.scope)).at(-1)?.frame_hash ?? null,
        payload: eventPayload(item.root, String(item.pointer!.scope), operationId, 'migration.pointer.imported', data),
      });
      return { committed: true, duplicate: false, item: item.id, root: item.root, source: reference(frame) };
    });
  }

  async rollback(batchId: string, reason: string, operationId: string): Promise<JsonObject> {
    return this.#transaction(async (tx, state) => {
      const batch = state.batches.get(label(batchId));
      requireThat(batch, 'migration-batch', 'Choose an existing incomplete destination batch.');
      if (batch.aborted) {
        const original = tx.ledger.find(f => f.payload.event === 'batch.rolledback' && object(f.payload.data).batch === batchId)!;
        requireThat(object(original.payload.data).reason === reason, 'idempotency-conflict', 'An existing rollback reason cannot be rewritten.');
        return { rolledBack: true, duplicate: true, batch: batchId, source: reference(original), activeItemsRemoved: 0, stagedEvidenceRetained: true };
      }
      const committed = batch.items.filter(id => {
        const item = this.#item(id);
        return this.#receipt(tx.snapshot.roots.find(r => r.definition.root === item.root), item);
      });
      requireThat(committed.length === 0, 'migration-rollback', 'Incomplete-only rollback cannot delete already committed roots or pointers.');
      const frame = await this.#control(tx, 'batch.rolledback', { batch: batchId, reason: text(reason, 500) }, operationId);
      return { rolledBack: true, batch: batchId, source: reference(frame), activeItemsRemoved: 0, stagedEvidenceRetained: true };
    });
  }

  async projection(): Promise<JsonObject> {
    const { snapshot, ledger } = await this.bots.repository.migrationSnapshot(this.plan.owner);
    requireThat(snapshot.roots.every(r => this.plan.roots.includes(r.definition.root)),
      'migration-isolation', 'The isolated destination contains an unselected root; migration qualification refuses.');
    const state = controls(ledger, this.plan, this.authorityHash);
    const roots = snapshot.roots.filter(r => this.plan.roots.includes(r.definition.root)).map(r => {
      const p = projectBot(r);
      const legacy = memoryFrames(r).filter(f => sourceReference(f).ownership === 'legacy-root-stream').length;
      return { root: p.root, name: p.name, hidden: p.hidden, scopes: p.scopes, pointers: p.pointers,
        artifacts: p.artifacts.map(a => ({ id: a.id!, name: a.name!, contentHash: a.contentHash!, mediaType: a.mediaType!, scope: a.scope! })),
        capability: r.definition.capability, branches: p.branches, heads: p.heads, sources: p.sources,
        sourceOwnership: { sourceOwned: memoryFrames(r).length - legacy, legacyRootStream: legacy, copiedCentralActivity: false },
        frameCount: r.streams.body.length + r.streams.swarm.length + memoryFrames(r).length
          + r.branches.reduce((n, b) => n + b.frames.length, 0) + (r.sources ?? []).reduce((n, s) => n + s.branches.reduce((n, b) => n + b.frames.length, 0), 0) };
    });
    const imported = this.plan.items.filter(item => this.#receipt(snapshot.roots.find(r => r.definition.root === item.root), item));
    const pending = this.plan.items.filter(item => !imported.includes(item)).map(i => i.id);
    const cursor = { control: ledger.length ? reference(ledger.at(-1)!) : null,
      roots: roots.map(r => ({ root: r.root, heads: r.heads, sources: r.sources, branches: r.branches })) };
    const projection: JsonObject = {
      schema: 'rapp-work.migration-projection/1', root: this.plan.owner, planHash: this.planHash,
      mode: this.plan.mode, cursor, cursorHash: contentHash(cursor), roots,
      imported: imported.map(i => ({ id: i.id, root: i.root, title: i.title, kind: i.kind,
        classification: i.classification, provider: i.provider, sourceIdentity: i.sourceIdentity, sourceLocator: i.sourceLocator })),
      batches: [...state.batches.values()].map(b => ({ id: b.id, items: b.items, status: b.aborted ? 'rolled-back' : b.items.every(id => imported.some(i => i.id === id)) ? 'committed' : 'incomplete' })),
      pending, complete: state.bound && pending.length === 0,
      counts: { roots: roots.length, items: imported.length, pointers: imported.filter(i => i.kind === 'estate-pointer').length,
        scopes: roots.reduce((n, r) => n + r.scopes.length, 0), branches: roots.reduce((n, r) => n + r.branches.length, 0),
        artifacts: roots.reduce((n, r) => n + r.artifacts.length, 0), controlFrames: ledger.length, activeFrames: snapshot.frameCount },
      authority: this.authority.evidence,
    };
    requireThat(Buffer.byteLength(canonicalJson(projection)) <= 524_288, 'migration-projection-bound', 'The full selected estate exceeds this projection bound; no silent frame or scope filtering is allowed.');
    return projection;
  }

  async finish(): Promise<JsonObject> {
    const projection = await this.projection();
    requireThat(projection.complete === true, 'migration-incomplete', 'The full approved estate selection is incomplete; release qualification refuses.');
    const counts = object(projection.counts);
    for (const key of ['roots', 'items', 'pointers', 'scopes', 'artifacts', 'branches']) {
      requireThat(counts[key] === this.plan.expected[key], 'migration-parity', `The ${key} count does not match the complete source selection.`);
    }
    const roots = projection.roots as JsonObject[];
    requireThat(canonicalJson(roots.map(r => r.root).sort()) === canonicalJson([...this.plan.roots].sort()),
      'migration-parity', 'The root GUID set changed.');
    const forms: Record<string, number> = {};
    for (const root of roots) for (const scope of root.scopes as JsonObject[]) {
      const kind = String(scope.kind);
      forms[kind] = (forms[kind] ?? 0) + 1;
    }
    requireThat(canonicalJson(forms) === canonicalJson(this.plan.expected.forms), 'migration-parity', 'The complete hidden recursive form/lineage counts do not match.');
    const imported = projection.imported as JsonObject[];
    for (const [property, expected] of [['classification', 'classifications'], ['provider', 'providers']] as const) {
      const actual: Record<string, number> = {};
      for (const item of imported) actual[String(item[property])] = (actual[String(item[property])] ?? 0) + 1;
      requireThat(canonicalJson(actual) === canonicalJson(this.plan.expected[expected]), 'migration-parity', 'Source classifications/provider provenance changed.');
    }
    const controlled = this.plan.mode === 'controlled-local';
    return {
      fixtureMigrationComplete: !controlled,
      controlledLocalMigrationComplete: controlled,
      releaseEligible: false,
      projection,
      reason: controlled
        ? 'The approved selection completed under injected authority; external cutover acceptance remains pending.'
        : 'This is the observed fixture gate. An approved controlled-local migration and canonical adoption remain mandatory for release.',
    };
  }
}
