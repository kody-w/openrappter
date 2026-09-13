import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildFrame, canonicalJson, frameHead, isUtc, mergeStoredChains, parseCanonicalJson, rootTail, signerOf, streamFor,
  verifiedFrame, verifySelectedAuthority, type Family, type FrameSigner, type JsonObject,
  type RappFrame, type SignaturePolicy,
} from './canonical.js';
import { eventKind, label, rootDefinition, workEvent, type RootDefinition } from './contract.js';
import { Refusal, requireThat } from './errors.js';

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
}
export interface StoreSnapshot { readonly roots: readonly RootSnapshot[]; readonly frameCount: number }
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
export interface RepositoryOptions {
  directory: string;
  signatures?: SignaturePolicy;
  lockTimeoutMs?: number;
  fault?: (point: 'before-publish' | 'after-publish') => void;
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
  private constructor(options: RepositoryOptions) {
    this.directory = path.resolve(options.directory);
    this.#options = options;
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
    requireThat(entries.every(name => name === 'bots' || name === '.writer-lock'), 'source-directory',
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
      requireThat(canonicalJson(rootEntries) === canonicalJson(['body', 'branches', 'memory', 'swarm']),
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
      const operationIds = new Set([definition.operationId]);
      for (const frame of streams.memory) {
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
        branches.push({ family, head: match[2]!, frames });
        frameCount += frames.length;
      }
      roots.push(Object.freeze({ definition, streams: Object.freeze(streams), branches: Object.freeze(branches) }));
    }
    return Object.freeze({ roots: Object.freeze(roots), frameCount });
  }

  async snapshot(): Promise<StoreSnapshot> { return this.#locked(() => this.#scan()); }

  async #publish(directory: string, frame: RappFrame): Promise<void> {
    await assertAncestors(directory);
    const destination = path.join(directory, `${String(frame.seq).padStart(12, '0')}.json`);
    const pending = path.join(directory, `pending-${randomUUID()}`);
    const handle = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let linked = false;
    try {
      await handle.writeFile(canonicalJson(frame), 'utf8');
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

  async transaction<T>(operation: (transaction: Transaction) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
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
          return frame;
        },
        append: async input => {
          once();
          requireThat(input.family !== 'body', 'root-identity', 'The root genesis cannot be replaced.');
          const root = snapshot.roots.find(r => r.definition.root === input.root);
          requireThat(root, 'root-not-found', 'Choose an existing canonical root GUID.');
          const frames = root.streams[input.family];
          const head = frames.at(-1) ?? null;
          requireThat((head?.frame_hash ?? null) === input.expectedHead, 'stale-head', 'Canonical context changed; review the new head before applying work.');
          if (input.family === 'memory') {
            const event = workEvent(input.payload);
            requireThat(event.root === input.root && input.kind === eventKind(event.event), 'root-isolation', 'Wrong root or event kind.');
            requireThat(!root.streams.memory.some(f => f.payload.operationId === event.operationId),
              'idempotency-conflict', 'An operation ID already has a canonical receipt.');
          }
          const frame = buildFrame({ kind: input.kind, streamId: streamFor(input.root, input.family),
            utc: input.utc, payload: input.payload, head: head ? frameHead(head) : null,
            ...(input.signer ? { signer: input.signer } : {}),
            ...(this.#options.signatures ? { signatures: this.#options.signatures } : {}) });
          requireThat(signerOf(frame) === root.definition.signer, 'root-signature', 'A root cannot append as another signer.');
          if (input.payload.operationId !== undefined) {
            const operationId = label(input.payload.operationId);
            requireThat(operationId !== root.definition.operationId && !Object.values(root.streams).flat().some(f => f.payload.operationId === operationId),
              'idempotency-conflict', 'A command ID already belongs to another canonical root operation.');
          }
          await this.#publish(this.#framesDirectory(input.root, input.family), frame);
          return frame;
        },
        preserveBranch: async (root, family, frames) => {
          once();
          requireThat(snapshot.roots.some(r => r.definition.root === root) && frames.length > 0
            && frames.length <= MAX_FRAMES, 'branch', 'A complete bounded branch of an existing root is required.');
          let previous: RappFrame | null = null;
          for (const f of frames) {
            previous = verifiedFrame(canonicalJson(f), streamFor(root, family),
              previous ? frameHead(previous) : null, this.#options.signatures);
            requireThat(signerOf(f) === snapshot.roots.find(r => r.definition.root === root)!.definition.signer,
              'root-signature', 'Branches retain their original root signer.');
          }
          const head = frames.at(-1)!;
          const directory = path.join(this.#rootDirectory(root), 'branches', `${family}-${head.frame_hash}`, 'frames');
          try { await mkdir(path.dirname(directory), { mode: 0o700 }); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const existing = await this.#readChain(directory, streamFor(root, family));
            requireThat(canonicalJson(existing) === canonicalJson(frames), 'branch', 'Existing immutable branch differs.');
            return;
          }
          await mkdir(directory, { mode: 0o700 });
          for (const f of frames) await this.#publish(directory, f);
        },
      });
    });
  }

  async root(root: string): Promise<RootSnapshot> {
    const result = (await this.snapshot()).roots.find(r => r.definition.root === root);
    if (!result) throw new Refusal('root-not-found', 'Choose an existing canonical root GUID.');
    return result;
  }

  async orderSelection(hashes: ReadonlySet<string>): Promise<readonly RappFrame[]> {
    return this.#locked(async () => {
      const snapshot = await this.#scan();
      const ordered = mergeStoredChains(snapshot.roots.flatMap(r => Object.values(r.streams)), this.#options.signatures);
      const selected = ordered.filter(f => hashes.has(f.frame_hash));
      requireThat(selected.length === hashes.size, 'stale-projection', 'A selected canonical occurrence is no longer available.');
      return selected;
    });
  }
}
