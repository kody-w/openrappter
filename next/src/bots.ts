import {
  AUTHORITY, canonicalJson, mintIdentity, type FrameSigner, type JsonObject, type RappFrame,
} from './canonical.js';
import {
  ROOT_SCHEMA, defaultScopes, eventKind, eventPayload, label, text,
  type CapabilityReference, type RootDefinition,
} from './contract.js';
import { requireThat } from './errors.js';
import { orient, projectBot, type BotProjection } from './projection.js';
import { CanonicalRepository, type RootSnapshot, type Transaction } from './repository.js';
import type { SharedBrainstem } from './spine.js';

export interface RootSigner { readonly root: string; readonly signer: FrameSigner }
export interface BotOptions {
  repository: CanonicalRepository;
  capability: CapabilityReference;
  spine: SharedBrainstem;
  signers?: readonly RootSigner[];
  clock?: () => string;
}

export function findRoot(transaction: Transaction, root: string): RootSnapshot {
  const found = transaction.snapshot.roots.find(r => r.definition.root === root);
  requireThat(found, 'root-not-found', 'Choose an existing canonical root GUID.');
  return found;
}

export class Bots {
  readonly repository: CanonicalRepository;
  readonly spine: SharedBrainstem;
  readonly capability: CapabilityReference;
  readonly #signers: ReadonlyMap<string, FrameSigner>;
  readonly #clock: () => string;
  #selected: string | null = null;

  constructor(options: BotOptions) {
    this.repository = options.repository;
    this.spine = options.spine;
    this.capability = options.capability;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#signers = new Map(options.signers?.map(s => [s.root, s.signer]) ?? []);
  }

  now(): string { return this.#clock(); }
  signer(root: string): FrameSigner | undefined { return this.#signers.get(root); }

  async create(input: { name: string; operationId: string; keyedRoot?: string }): Promise<BotProjection> {
    const name = text(input.name, 120);
    const operationId = label(input.operationId);
    const root = await this.repository.transaction(async transaction => {
      const existing = transaction.snapshot.roots.find(r => r.definition.operationId === operationId);
      if (existing) {
        requireThat(existing.definition.name === name && (input.keyedRoot === undefined || existing.definition.root === input.keyedRoot),
          'idempotency-conflict', 'This operation ID already created a different root.');
        return existing.definition.root;
      }
      const root = input.keyedRoot ?? mintIdentity('local', 'bot');
      const signer = this.signer(root);
      requireThat(input.keyedRoot === undefined || signer, 'signing-authority-unavailable',
        'A keyed root requires an explicitly injected independently custodied signer.');
      const definition: RootDefinition = {
        schema: ROOT_SCHEMA, operationId, root, name, scopes: defaultScopes(name), capability: this.capability, authority: { ...AUTHORITY },
        signer: signer ? root : null,
        policy: { externalEffects: 'explicit-approval', nativeStores: 'pointer-only', memory: 'public-turns-and-outcomes' },
      };
      await transaction.create(definition, this.now(), signer);
      return root;
    });
    return this.project(root);
  }

  async list(includeHidden = false): Promise<readonly { root: string; name: string; hidden: boolean }[]> {
    return (await this.repository.snapshot()).roots.map(projectBot).filter(p => includeHidden || !p.hidden)
      .map(p => ({ root: p.root, name: p.name, hidden: p.hidden }));
  }

  async project(root: string): Promise<BotProjection> { return projectBot(await this.repository.root(root)); }
  async whereWereWe(root: string): Promise<ReturnType<typeof orient>> { return orient(await this.project(root)); }
  async select(root: string): Promise<BotProjection> {
    const projection = await this.project(root);
    requireThat(!projection.hidden, 'bot-hidden', 'Restore this same root GUID before selecting it.');
    this.#selected = root;
    return projection;
  }
  selected(): string {
    requireThat(this.#selected, 'selection-required', 'Select one canonical root bot.');
    return this.#selected;
  }

  async appendEvent(transaction: Transaction, root: RootSnapshot, event: string, data: JsonObject,
    operationId: string, scope = 'root', expectedHead?: string | null): Promise<RappFrame> {
    const payload = eventPayload(root.definition.root, scope, operationId, event, data);
    const duplicate = root.streams.memory.find(f => f.payload.operationId === operationId);
    if (duplicate) {
      requireThat(canonicalJson(duplicate.payload) === canonicalJson(payload), 'idempotency-conflict',
        'This operation ID already records a different bounded outcome.');
      return duplicate;
    }
    const signer = this.signer(root.definition.root);
    requireThat(root.definition.signer === null || signer, 'signing-authority-unavailable', 'The root signer is unavailable; unsigned continuation is refused.');
    const previous = root.streams.memory.at(-1);
    const utc = this.now();
    requireThat(!previous || utc >= previous.utc, 'clock', 'The host clock regressed; canonical time will not be rewritten.');
    return transaction.append({ root: root.definition.root, family: 'memory', kind: eventKind(event), payload, utc,
      expectedHead: expectedHead === undefined ? previous?.frame_hash ?? null : expectedHead, ...(signer ? { signer } : {}) });
  }

  async visibility(root: string, hidden: boolean, operationId: string): Promise<BotProjection> {
    requireThat(typeof hidden === 'boolean', 'contract', 'Only hide and restore are supported.');
    await this.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      return this.appendEvent(transaction, snapshot, 'root.visibility', { hidden }, operationId);
    });
    if (hidden) {
      if (this.#selected === root) this.#selected = null;
      await this.spine.releaseRoot(root);
    }
    return this.project(root);
  }
}
