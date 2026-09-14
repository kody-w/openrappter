import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildFrame, canonicalJson, frameHead, isUtc, mergeStoredChains, parseCanonicalJson, rootTail, signerOf, streamFor,
  verifiedFrame, verifySelectedAuthority, type Family, type FrameSigner, type JsonObject,
  type RappFrame, type SignaturePolicy,
} from './canonical.js';
import { eventKind, label, rootDefinition, workEvent, type RootDefinition } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import { CANONICAL_FILE, MIGRATION_LIMITS, migrationStream, verifyRootFiles } from './migration-contract.js';
import { memoryFrames, memoryHeadHashes, rawMemoryFrames, sourceChain, sourceKey, sourceParents, sourceStream, type SourceMemory } from './source-memory.js';
import { assertCanonicalSelection } from './canonical-forks.js';

const FAMILIES: readonly Family[] = ['body', 'memory', 'swarm'];
const FILE = /^\d{12}\.json$/u;
const TAIL = /^[0-9a-f]{64}$/u;
const MAX_FRAMES = 8_192;
const MAX_ROOTS = 64;
const NOFOLLOW = constants.O_NOFOLLOW;

export interface RootSnapshot {
  readonly definition: RootDefinition;
  readonly streams: Readonly<Record<Family, readonly RappFrame[]>>;
  readonly branches: readonly { family: Family; head: string; frames: readonly RappFrame[] }[];
  readonly sources?: readonly SourceMemory[];
}
export interface StoreSnapshot { readonly roots: readonly RootSnapshot[]; readonly frameCount: number }
export interface PublicationNotice { readonly root: string; readonly event: string | null; readonly frameHash: string }
export interface Append {
  root: string;
  family: Family;
  payload: JsonObject;
  kind: string;
  utc: string;
  expectedHead: string | null;
  signer?: FrameSigner;
}
export interface Transaction {
  readonly snapshot: StoreSnapshot;
  create(definition: RootDefinition, utc: string, signer?: FrameSigner): Promise<RappFrame>;
  append(input: Append): Promise<RappFrame>;
  preserveBranch(root: string, family: Family, frames: readonly RappFrame[]): Promise<void>;
}
export interface MigrationTransaction {
  readonly snapshot: StoreSnapshot;
  readonly ledger: readonly RappFrame[];
  appendControl(payload: JsonObject, utc: string): Promise<RappFrame>;
  appendRoot(input: Append): Promise<RappFrame>;
  materializeRoot(root: string, files: ReadonlyMap<string, Buffer>, receipt: Append, publication: string): Promise<RootSnapshot>;
}
export interface RepositoryOptions {
  directory: string;
  signatures?: SignaturePolicy;
  lockTimeoutMs?: number;
  fault?: (point: 'before-publish' | 'after-publish') => void;
  migrationFault?: (point: 'frame-materialized' | 'before-root-publish', root: string) => void;
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  requireThat(info.isDirectory() && !info.isSymbolicLink(), 'path-boundary', 'A real directory is required.');
}

async function assertAncestors(directory: string): Promise<void> {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertDirectory(current);
  }
}

async function readBytes(filename: string): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat();
    requireThat(info.isFile() && info.nlink === 1 && info.size <= 1_048_576,
      'path-boundary', 'A bounded non-linked canonical frame file is required.');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export class CanonicalRepository {
  readonly directory: string;
  readonly #options: RepositoryOptions;
  readonly #publicationListeners = new Set<(notice: PublicationNotice) => void | Promise<void>>();
  private constructor(options: RepositoryOptions) {
    this.directory = path.resolve(options.directory);
    this.#options = options;
  }

  onPublication(listener: (notice: PublicationNotice) => void | Promise<void>): () => void {
    this.#publicationListeners.add(listener);
    return () => { this.#publicationListeners.delete(listener); };
  }
  #notify(notice: PublicationNotice): void {
    const failed = (): void => { process.stderr.write('Canonical publication observer failed; committed work is unchanged. Reconstruct from canonical sources.\n'); };
    for (const listener of this.#publicationListeners) {
      try { void Promise.resolve(listener(notice)).catch(failed); }
      catch { failed(); }
    }
  }

  static async open(options: RepositoryOptions): Promise<CanonicalRepository> {
    await verifySelectedAuthority();
    requireThat(typeof options.directory === 'string' && options.directory.length > 0,
      'store-required', 'Choose an explicit, dedicated canonical state directory.');
    const repository = new CanonicalRepository(options);
    const directory = repository.directory;
    requireThat(path.basename(directory) !== '.' && directory !== path.parse(directory).root,
      'path-boundary', 'The filesystem root is not a state directory.');
    requireThat(!directory.split(path.sep).some(part => ['.copilot', '.claude', '.hermes', '.grokbot', '.scout', 'Library'].includes(part)),
      'native-store', 'Native profiles are pointer-only, never canonical output directories.');
    await assertAncestors(path.dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await assertDirectory(directory);
    const info = await lstat(directory);
    requireThat((info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()),
      'private-store', 'The dedicated state directory must be owner-only (0700). Existing directories are never chmodded.');
    const entries = await readdir(directory);
    requireThat(entries.every(name => name === 'bots' || name === '.writer-lock' || name === 'migration'), 'source-directory',
      'Refusing a source/native/unknown directory; only canonical bot storage belongs here.');
    await mkdir(path.join(directory, 'bots'), { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await assertDirectory(path.join(directory, 'bots'));
    await repository.snapshot();
    return repository;
  }

  async #locked<T>(operation: () => Promise<T>): Promise<T> {
    const lock = path.join(this.directory, '.writer-lock');
    const deadline = Date.now() + (this.#options.lockTimeoutMs ?? 2_000);
    await assertAncestors(this.directory);
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireThat(Date.now() < deadline, 'store-busy',
          'Another writer or an interrupted write holds the store. No lock stealing or automatic recovery.');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    try { return await operation(); } finally { await rmdir(lock); }
  }

  #rootDirectory(root: string): string { return path.join(this.directory, 'bots', rootTail(root)); }
  #framesDirectory(root: string, family: Family): string {
    return path.join(this.#rootDirectory(root), family, 'frames');
  }
  #sourceDirectory(root: string, scope: string): string {
    return scope === 'root' ? this.#framesDirectory(root, 'memory')
      : path.join(this.#rootDirectory(root), 'scopes', sourceKey(root, scope), 'frames');
  }

  async #readChain(directory: string, stream: string): Promise<readonly RappFrame[]> {
    await assertAncestors(directory);
    const files = (await readdir(directory)).sort();
    requireThat(files.length <= MAX_FRAMES && files.every(name => FILE.test(name)),
      'incomplete-write', 'Unknown, pending or excessive frame files require explicit recovery.');
    const frames: RappFrame[] = [];
    for (let index = 0; index < files.length; index++) {
      requireThat(files[index] === `${String(index).padStart(12, '0')}.json`, 'canonical-gap', 'A canonical stream was truncated or has a gap.');
      frames.push(verifiedFrame(await readBytes(path.join(directory, files[index]!)), stream,
        frames.length ? frameHead(frames.at(-1)!) : null, this.#options.signatures));
    }
    return Object.freeze(frames);
  }

  async #scan(): Promise<StoreSnapshot> {
    const botsDirectory = path.join(this.directory, 'bots');
    await assertAncestors(botsDirectory);
    const roots: RootSnapshot[] = [];
    let frameCount = 0;
    const names = (await readdir(botsDirectory)).sort();
    requireThat(names.length <= MAX_ROOTS && names.every(name => TAIL.test(name)), 'root-catalog', 'The canonical root catalog is invalid or full.');
    for (const name of names) {
      const rootDirectory = path.join(botsDirectory, name);
      await assertDirectory(rootDirectory);
      const rootEntries = (await readdir(rootDirectory)).sort();
      requireThat(canonicalJson(rootEntries.filter(e => e !== 'scopes')) === canonicalJson(['body', 'branches', 'memory', 'swarm']),
        'incomplete-write', 'Incomplete rooted data is not a new bot and will not be reminted.');
      const genesisBytes = await readBytes(path.join(rootDirectory, 'body/frames/000000000000.json'));
      const candidate = parseCanonicalJson(genesisBytes) as JsonObject;
      const definition = rootDefinition(candidate.payload);
      requireThat(rootTail(definition.root) === name, 'root-identity', 'Root GUID and storage locator disagree.');
      const streams = {} as Record<Family, readonly RappFrame[]>;
      for (const family of FAMILIES) {
        streams[family] = await this.#readChain(this.#framesDirectory(definition.root, family), streamFor(definition.root, family));
        frameCount += streams[family].length;
      }
      requireThat(streams.body.length === 1 && streams.body[0]!.kind === 'body.pulse',
        'root-identity', 'Root identity is exactly one immutable canonical genesis.');
      for (const family of FAMILIES) {
        requireThat(streams[family].every(frame => signerOf(frame) === definition.signer),
          'root-signature', 'A canonical frame is not signed by this root’s selected signer.');
      }
      const sources: SourceMemory[] = [];
      if (rootEntries.includes('scopes')) {
        const directory = path.join(rootDirectory, 'scopes');
        await assertDirectory(directory);
        const scopeNames = (await readdir(directory)).sort();
        requireThat(scopeNames.length <= 128 && scopeNames.every(name => TAIL.test(name)), 'source-scope', 'Invalid scoped source directories.');
        for (const key of scopeNames) {
          const sourceDirectory = path.join(directory, key);
          await assertAncestors(sourceDirectory);
          requireThat(canonicalJson((await readdir(sourceDirectory)).sort()) === '["branches","frames"]', 'source-scope', 'A scoped source contains unexpected state.');
          const first = parseCanonicalJson(await readBytes(path.join(sourceDirectory, 'frames/000000000000.json'))) as JsonObject;
          const event = workEvent(first.payload);
          requireThat(event.root === definition.root && event.scope !== 'root' && sourceKey(event.root, event.scope) === key,
            'source-ownership', 'Source GUID/scope and storage locator differ.');
          const stream = sourceStream(event.root, event.scope);
          const frames = await this.#readChain(path.join(sourceDirectory, 'frames'), stream);
          requireThat(frames.every(f => f.payload.root === event.root && f.payload.scope === event.scope && signerOf(f) === definition.signer),
            'source-ownership', 'An occurrence is not owned by this exact internal workspace/world.');
          const sourceBranches: { head: string; frames: readonly RappFrame[] }[] = [];
          const branchesDirectory = path.join(sourceDirectory, 'branches');
          await assertDirectory(branchesDirectory);
          for (const hash of (await readdir(branchesDirectory)).sort()) {
            requireThat(TAIL.test(hash), 'source-branch', 'Invalid source branch head.');
            const branch = await this.#readChain(path.join(branchesDirectory, hash, 'frames'), stream);
            requireThat(branch.length > 0 && branch.at(-1)!.frame_hash === hash
              && branch.every(f => f.payload.root === event.root && f.payload.scope === event.scope && signerOf(f) === definition.signer),
            'source-branch', 'A source branch changed identity or lost ancestry.');
            sourceBranches.push({ head: hash, frames: branch }); frameCount += branch.length;
          }
          sources.push(Object.freeze({ scope: event.scope, stream, frames, branches: Object.freeze(sourceBranches) }));
          frameCount += frames.length;
        }
      }
      const operationIds = new Set([definition.operationId]);
      for (const frame of [...streams.memory, ...sources.flatMap(s => s.frames)]) {
        const event = workEvent(frame.payload);
        requireThat(event.root === definition.root && frame.kind === eventKind(event.event),
          'root-isolation', 'An event is not bound to this root and registered memory kind.');
        requireThat(!operationIds.has(event.operationId), 'idempotency', 'A committed operation ID occurs twice.');
        operationIds.add(event.operationId);
      }
      for (const frame of streams.swarm) {
        if (frame.payload.operationId !== undefined) {
          const operationId = label(frame.payload.operationId);
          requireThat(!operationIds.has(operationId), 'idempotency', 'A command ID may not be rebound across canonical stream families.');
          operationIds.add(operationId);
        }
      }
      const branches: { family: Family; head: string; frames: readonly RappFrame[] }[] = [];
      const branchDirectory = path.join(rootDirectory, 'branches');
      await assertDirectory(branchDirectory);
      for (const branch of (await readdir(branchDirectory)).sort()) {
        const match = /^(body|memory|swarm)-([0-9a-f]{64})$/u.exec(branch);
        requireThat(match, 'branch', 'Unexpected branch storage.');
        const family = match[1] as Family;
        const frames = await this.#readChain(path.join(branchDirectory, branch, 'frames'), streamFor(definition.root, family));
        requireThat(frames.length > 0 && frames.at(-1)!.frame_hash === match[2], 'branch', 'A branch head or ancestry is missing.');
        requireThat(frames.every(f => signerOf(f) === definition.signer), 'root-signature', 'Retained branches must preserve the exact original root signer.');
        branches.push({ family, head: match[2]!, frames });
        frameCount += frames.length;
      }
      const root = Object.freeze({ definition, streams: Object.freeze(streams), branches: Object.freeze(branches),
        ...(sources.length ? { sources: Object.freeze(sources) } : {}) });
      memoryFrames(root);
      roots.push(root);
    }
    return Object.freeze({ roots: Object.freeze(roots), frameCount });
  }

  async snapshot(): Promise<StoreSnapshot> { return this.#locked(() => this.#scan()); }

  async #publish(directory: string, frame: RappFrame): Promise<void> {
    await this.#publishBytes(directory, frame.seq, Buffer.from(canonicalJson(frame)), false);
  }

  async #publishBytes(directory: string, seq: number, bytes: Buffer, allowExactExisting: boolean): Promise<void> {
    await assertAncestors(directory);
    const destination = path.join(directory, `${String(seq).padStart(12, '0')}.json`);
    if (allowExactExisting) {
      try {
        requireThat((await readBytes(destination)).equals(bytes), 'migration-existing-bytes', 'An unpublished canonical file differs; no overwrite or silent repair is permitted.');
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const pending = path.join(directory, `pending-${randomUUID()}`);
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let linked = false;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      this.#options.fault?.('before-publish');
      await link(pending, destination);
      linked = true;
      await unlink(pending);
      await syncDirectory(directory);
      this.#options.fault?.('after-publish');
    } catch (error) {
      if (!linked) await unlink(pending).catch(() => undefined);
      throw error;
    } finally { await handle.close(); }
  }

  async #appendRoot(snapshot: StoreSnapshot, input: Append): Promise<RappFrame> {
    requireThat(input.family !== 'body', 'root-identity', 'The root genesis cannot be replaced.');
    const root = snapshot.roots.find(r => r.definition.root === input.root);
    requireThat(root, 'root-not-found', 'Choose an existing canonical root GUID.');
    assertCanonicalSelection(root);
    const scope = input.family === 'memory' ? workEvent(input.payload).scope : 'root';
    const frames = input.family === 'memory' ? sourceChain(root, scope) : root.streams[input.family];
    const head = frames.at(-1) ?? null;
    requireThat((head?.frame_hash ?? null) === input.expectedHead, 'stale-head', 'Canonical context changed; review the new head before applying work.');
    if (input.family === 'memory') {
      const event = workEvent(input.payload);
      requireThat(event.root === input.root && input.kind === eventKind(event.event), 'root-isolation', 'Wrong root or event kind.');
      requireThat(!rawMemoryFrames(root).some(f => f.payload.operationId === event.operationId),
        'idempotency-conflict', 'An operation ID already has a canonical receipt.');
    }
    const control = input.family === 'memory' && ['client.granted', 'client.revoked', 'root.visibility', 'computer.replay.policy'].includes(String(input.payload.event));
    const payload = input.family === 'memory' && (scope !== 'root' || control)
      ? workEvent({ ...input.payload, parents: [...new Set([...sourceParents(root, scope),
        ...(control ? memoryHeadHashes(root) : []), ...(input.payload.parents as string[] ?? [])])] }) : input.payload;
    const frame = buildFrame({ kind: input.kind, streamId: input.family === 'memory' ? sourceStream(input.root, scope) : streamFor(input.root, input.family),
      utc: input.utc, payload, head: head ? frameHead(head) : null,
      ...(input.signer ? { signer: input.signer } : {}),
      ...(this.#options.signatures ? { signatures: this.#options.signatures } : {}) });
    requireThat(signerOf(frame) === root.definition.signer, 'root-signature', 'A root cannot append as another signer.');
    if (input.payload.operationId !== undefined) {
      const operationId = label(input.payload.operationId);
      requireThat(operationId !== root.definition.operationId && ![...rawMemoryFrames(root), ...root.streams.body, ...root.streams.swarm].some(f => f.payload.operationId === operationId),
        'idempotency-conflict', 'A command ID already belongs to another canonical root operation.');
    }
    if (input.family === 'memory') {
      const projected: RootSnapshot = scope === 'root' ? { ...root, streams: { ...root.streams, memory: [...frames, frame] } }
        : { ...root, sources: [...(root.sources ?? []).filter(s => s.scope !== scope),
          { scope, stream: frame.stream_id, frames: [...frames, frame], branches: root.sources?.find(s => s.scope === scope)?.branches ?? [] }] };
      memoryFrames(projected);
      assertCanonicalSelection(projected);
    } else {
      assertCanonicalSelection({ ...root, streams: { ...root.streams, [input.family]: [...frames, frame] } });
    }
    const directory = input.family === 'memory' ? this.#sourceDirectory(input.root, scope) : this.#framesDirectory(input.root, input.family);
    if (input.family === 'memory' && scope !== 'root') {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(path.join(path.dirname(directory), 'branches'), { recursive: true, mode: 0o700 });
    }
    try { await this.#publish(directory, frame); }
    catch (error) {
      if (input.family === 'memory' && scope !== 'root' && !frames.length && !(await readdir(directory)).length) {
        await rmdir(path.join(path.dirname(directory), 'branches'));
        await rmdir(directory);
        await rmdir(path.dirname(directory));
      }
      throw error;
    }
    return frame;
  }

  async transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    let publication: PublicationNotice | null = null;
    const result = await this.#locked(async () => {
      const snapshot = await this.#scan();
      let written = false;
      const once = (): void => {
        requireThat(!written, 'atomicity', 'A transaction publishes one complete canonical outcome.');
        written = true;
      };
      return operation({
        snapshot,
        create: async (value, utc, signer) => {
          once();
          const definition = rootDefinition(value);
          requireThat(isUtc(utc), 'clock', 'A valid UTC clock is required.');
          const existing = snapshot.roots.find(r => r.definition.operationId === definition.operationId);
          if (existing) {
            requireThat(canonicalJson(existing.definition) === canonicalJson(definition), 'idempotency-conflict', 'An operation ID is already bound to different root data.');
            return existing.streams.body[0]!;
          }
          requireThat(snapshot.roots.length < MAX_ROOTS, 'root-capacity',
            'The canonical catalog already contains 64 roots, including hidden roots. No directory or genesis was created.');
          requireThat(!snapshot.roots.some(r => r.definition.root === definition.root), 'root-identity', 'Root GUID already exists.');
          const frame = buildFrame({ kind: 'body.pulse', streamId: definition.root, payload: definition,
            utc, head: null, ...(signer ? { signer } : {}), ...(this.#options.signatures ? { signatures: this.#options.signatures } : {}) });
          requireThat(signerOf(frame) === definition.signer, 'root-signature', 'The root genesis requires its selected signer.');
          const directory = this.#rootDirectory(definition.root);
          await mkdir(directory, { mode: 0o700 });
          for (const family of FAMILIES) await mkdir(this.#framesDirectory(definition.root, family), { recursive: true, mode: 0o700 });
          await mkdir(path.join(directory, 'branches'), { mode: 0o700 });
          await this.#publish(this.#framesDirectory(definition.root, 'body'), frame);
          await syncDirectory(path.join(this.directory, 'bots'));
          publication = { root: definition.root, event: null, frameHash: frame.frame_hash };
          return frame;
        },
        append: async input => {
          once();
          const frame = await this.#appendRoot(snapshot, input);
          publication = { root: input.root, event: typeof input.payload.event === 'string' ? input.payload.event : null, frameHash: frame.frame_hash };
          return frame;
        },
        preserveBranch: async (root, family, frames) => {
          once();
          requireThat(snapshot.roots.some(r => r.definition.root === root) && frames.length > 0
            && frames.length <= MAX_FRAMES, 'branch', 'A complete bounded branch of an existing root is required.');
          const scope = family === 'memory' && frames[0]!.stream_id !== streamFor(root, 'memory') ? workEvent(frames[0]!.payload).scope : 'root';
          const stream = family === 'memory' ? sourceStream(root, scope) : streamFor(root, family);
          requireThat(scope === 'root' || sourceChain(snapshot.roots.find(r => r.definition.root === root)!, scope).length,
            'source-branch', 'A source branch must belong to an existing original source stream.');
          let previous: RappFrame | null = null;
          for (const f of frames) {
            previous = verifiedFrame(canonicalJson(f), stream,
              previous ? frameHead(previous) : null, this.#options.signatures);
            requireThat(signerOf(f) === snapshot.roots.find(r => r.definition.root === root)!.definition.signer,
              'root-signature', 'Branches retain their original root signer.');
            if (family === 'memory') requireThat(f.payload.root === root && f.kind === eventKind(workEvent(f.payload).event)
              && (scope === 'root' || f.payload.scope === scope), 'source-ownership', 'A branch cannot reassign its original root/scope.');
          }
          const head = frames.at(-1)!;
          const directory = family === 'memory' && scope !== 'root'
            ? path.join(path.dirname(this.#sourceDirectory(root, scope)), 'branches', head.frame_hash, 'frames')
            : path.join(this.#rootDirectory(root), 'branches', `${family}-${head.frame_hash}`, 'frames');
          try { await mkdir(path.dirname(directory), { mode: 0o700 }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const existing = await this.#readChain(directory, stream);
            requireThat(canonicalJson(existing) === canonicalJson(frames), 'branch', 'Existing immutable branch differs.');
            return;
          }
          await mkdir(directory, { mode: 0o700 });
          for (const f of frames) await this.#publish(directory, f);
        },
      });
    });
    if (publication) this.#notify(publication);
    return result;
  }

  async root(root: string): Promise<RootSnapshot> {
    const result = (await this.snapshot()).roots.find(r => r.definition.root === root);
    if (!result) throw new Refusal('root-not-found', 'Choose an existing canonical root GUID.');
    return result;
  }

  async orderSelection(hashes: ReadonlySet<string>): Promise<readonly RappFrame[]> {
    return this.#locked(async () => {
      const snapshot = await this.#scan();
      for (const root of snapshot.roots) {
        if ([...Object.values(root.streams).flat(), ...(root.sources ?? []).flatMap(s => s.frames)].some(f => hashes.has(f.frame_hash))) {
          assertCanonicalSelection(root);
        }
      }
      const ordered = mergeStoredChains(snapshot.roots.flatMap(r => [...Object.values(r.streams), ...(r.sources ?? []).map(s => s.frames)]), this.#options.signatures);
      const selected = ordered.filter(f => hashes.has(f.frame_hash));
      requireThat(selected.length === hashes.size, 'stale-projection', 'A selected canonical occurrence is no longer available.');
      return selected;
    });
  }

  async #migrationLedger(owner: string): Promise<readonly RappFrame[]> {
    const directory = path.join(this.directory, 'migration', rootTail(owner), 'frames');
    try {
      const frames = await this.#readChain(directory, migrationStream(owner));
      requireThat(frames.every(f => f.kind === 'memory.save' && signerOf(f) === owner),
        'migration-authority', 'Migration coordination is an owner-signed canonical memory stream.');
      return frames;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async migrationSnapshot(owner: string): Promise<{ snapshot: StoreSnapshot; ledger: readonly RappFrame[] }> {
    return this.#locked(async () => ({ snapshot: await this.#scan(), ledger: await this.#migrationLedger(owner) }));
  }

  async migrationTransaction<T>(owner: string, signer: FrameSigner, operation: (tx: MigrationTransaction) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
      const snapshot = await this.#scan();
      const ledger = [...await this.#migrationLedger(owner)];
      return operation({
        snapshot, ledger,
        appendControl: async (payload, utc) => {
          requireThat(ledger.length < MIGRATION_LIMITS.controlFrames, 'migration-bound', 'The canonical migration ledger limit is reached; no partial silent truncation is permitted.');
          const frame = buildFrame({ kind: 'memory.save', streamId: migrationStream(owner),
            utc, payload, head: ledger.length ? frameHead(ledger.at(-1)!) : null, signer,
            ...(this.#options.signatures ? { signatures: this.#options.signatures } : {}) });
          requireThat(signerOf(frame) === owner, 'migration-authority', 'The selected migration owner must sign coordination.');
          const directory = path.join(this.directory, 'migration', rootTail(owner), 'frames');
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await this.#publish(directory, frame);
          ledger.push(frame);
          return frame;
        },
        appendRoot: input => this.#appendRoot(snapshot, input),
        materializeRoot: async (root, files, receipt, publication) => {
          requireThat(/^[0-9a-f]{64}$/u.test(publication) && this.#options.signatures, 'migration-publication', 'An exact publication identity and selected signature policy are required.');
          requireThat(!snapshot.roots.some(r => r.definition.root === root), 'migration-collision', 'Existing roots cannot be overwritten or silently merged.');
          requireThat(snapshot.roots.length < MAX_ROOTS, 'root-capacity', 'The complete canonical root catalog is full, including hidden roots.');
          const source = verifyRootFiles(root, files, this.#options.signatures);
          assertCanonicalSelection(source);
          requireThat(receipt.root === root && receipt.family === 'memory' && receipt.kind === 'memory.save',
            'migration-receipt', 'A rooted canonical import receipt is required.');
          const last = source.streams.memory.at(-1);
          requireThat(receipt.expectedHead === (last?.frame_hash ?? null), 'migration-receipt', 'The receipt must append to the original source head.');
          const imported = buildFrame({ kind: receipt.kind, streamId: streamFor(root, 'memory'), utc: receipt.utc,
            payload: receipt.payload, head: last ? frameHead(last) : null,
            ...(receipt.signer ? { signer: receipt.signer } : {}), signatures: this.#options.signatures });
          requireThat(signerOf(imported) === source.definition.signer, 'migration-receipt', 'The original root signer must authorize the successor receipt.');
          const staged = path.join(this.directory, 'migration', 'materialized', publication, rootTail(root));
          await mkdir(staged, { recursive: true, mode: 0o700 });
          for (const family of FAMILIES) await mkdir(path.join(staged, family, 'frames'), { recursive: true, mode: 0o700 });
          await mkdir(path.join(staged, 'branches'), { recursive: true, mode: 0o700 });
          for (const [relative, bytes] of files) {
            requireThat(CANONICAL_FILE.test(relative), 'migration-path', 'Only exact canonical frame paths may materialize.');
            const target = path.join(staged, relative);
            await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            if (relative.startsWith('scopes/')) await mkdir(path.join(staged, 'scopes', relative.split('/')[1]!, 'branches'), { recursive: true, mode: 0o700 });
            await this.#publishBytes(path.dirname(target), Number(path.basename(relative, '.json')), bytes, true);
            this.#options.migrationFault?.('frame-materialized', root);
          }
          await this.#publishBytes(path.join(staged, 'memory', 'frames'), imported.seq, Buffer.from(canonicalJson(imported)), true);
          await syncDirectory(staged);
          this.#options.migrationFault?.('before-root-publish', root);
          await rename(staged, this.#rootDirectory(root));
          await syncDirectory(path.join(this.directory, 'bots'));
          await syncDirectory(path.dirname(staged));
          return { ...source, streams: { ...source.streams, memory: [...source.streams.memory, imported] } };
        },
      });
    });
  }
}
