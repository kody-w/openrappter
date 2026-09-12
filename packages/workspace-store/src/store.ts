import { randomUUID } from 'node:crypto';
import {
  AUTHORITY_IDENTITY, EVIDENCE_SCHEMA, arrayItems, assertOptions, canonicalJson, frameHead,
  hashValue, isBodyStream, isLabel, isUtc, mintIdentity, parseCanonicalJson, PARTICLE_DOMAIN,
  scanChain, scanFrame, selectChainTrust, sha256, snapshotJson, streamFamily, validateEvidencePayload,
  validateHead, type AuthorityIdentity, type FrameHead, type JsonObject, type RappFrame,
  type SignaturePolicy, type StreamFamily, type VerifiedChain,
} from '@rapp-work/rapp1';
import { SecurityAuthority, type Capability, type CapabilityView, type Permission } from '@rapp-work/security';
import { artifactPath, PrivateRoot, WorkspaceError } from './filesystem.js';

const FAMILIES = ['body', 'memory', 'swarm'] as const;
export interface WorkspaceIdentity extends JsonObject {
  schema: 'rapp-work/identity/1';
  agent_id: string;
  workspace_id: string;
  principal_id: string;
  owner: string;
  slug: string;
  body_stream: string;
  memory_stream: string;
  swarm_stream: string;
  created_utc: string;
}
export type WorkspaceHeads = Readonly<Record<StreamFamily, FrameHead | null>>;
interface StreamCommit { stream_id: string; genesis: FrameHead | null; head: FrameHead | null }
interface Manifest {
  schema: 'rapp-work/workspace/1';
  identity_hash: string;
  protocol_revision: AuthorityIdentity;
  generation: number;
  streams: Record<StreamFamily, StreamCommit>;
}
interface PendingFile { path: string; sha256: string }
interface Journal {
  schema: 'rapp-work/batch/1'; previous_manifest_hash: string; next_manifest: Manifest; files: PendingFile[];
}
export interface EmptyStream {
  readonly empty: true;
  readonly streamId: string;
  readonly frames: readonly [];
  readonly head: null;
  readonly trust: { readonly classification: 'integrity-only'; readonly genesis: 'empty'; readonly persistedHead: 'empty' };
}
export interface WorkspaceSnapshot {
  readonly identity: WorkspaceIdentity;
  readonly heads: WorkspaceHeads;
  readonly streams: Readonly<Record<StreamFamily, VerifiedChain | EmptyStream>>;
  readonly manifestHash: string;
  readonly generation: number;
  readonly trust: { readonly classification: 'integrity-only'; readonly source: 'private-store'; readonly factualTruth: false; readonly authorship: false };
}
const snapshots = new WeakSet<object>();
export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  return value !== null && typeof value === 'object' && snapshots.has(value);
}
export type CrashPoint = 'identity-written' | 'journal-written' | 'frame-written' | 'before-commit' | 'manifest-written' | 'read-back';
export type FaultInjector = (point: CrashPoint, frameIndex: number | null) => void | Promise<void>;
interface StoreOptions {
  root: string;
  security: SecurityAuthority;
  signatures?: SignaturePolicy;
  lockTimeoutMs?: number;
  fault?: FaultInjector;
}
const WORKSPACE_TOKEN = Symbol('workspace-constructor');
declare const artifactBrand: unique symbol;
export interface ArtifactCapability { readonly [artifactBrand]: true }
interface ArtifactGrant { path: string; rights: readonly ('read' | 'write')[] }
export class CommitError extends WorkspaceError {
  constructor(readonly commitState: 'not-committed' | 'unknown', message: string) {
    super('commit-uncertain', message);
    this.name = 'CommitError';
  }
}

export class WorkspaceStore {
  readonly #root: PrivateRoot;
  readonly #options: StoreOptions;
  private constructor(root: PrivateRoot, options: StoreOptions) { this.#root = root; this.#options = options; }

  static async open(options: StoreOptions): Promise<WorkspaceStore> {
    assertOptions(options, ['root', 'security', 'signatures', 'lockTimeoutMs', 'fault'], ['root', 'security']);
    if (!(options.security instanceof SecurityAuthority)
      || (options.fault !== undefined && typeof options.fault !== 'function')
      || (options.lockTimeoutMs !== undefined && (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0))) {
      throw new TypeError('Invalid workspace store dependencies');
    }
    return new WorkspaceStore(await PrivateRoot.open(options.root, true), Object.freeze({ ...options }));
  }

  #grant(capability: Capability, permission: Permission): CapabilityView {
    const grant = this.#options.security.inspectCapability(capability, permission);
    if (!isLabel(grant.workspaceId, 100)) throw new WorkspaceError('workspace-id', 'Workspace locator must be a safe lowercase label');
    if (!grant.resources.includes(`workspace:${grant.workspaceId}`)) throw new WorkspaceError('scope', 'Explicit workspace resource required');
    return grant;
  }

  async create(capability: Capability, input: { owner: string; slug: string }): Promise<AgentWorkspace> {
    assertOptions(input, ['owner', 'slug']);
    if (!isLabel(input.owner, 39) || !isLabel(input.slug, 100)) throw new WorkspaceError('identity', 'Invalid canonical owner or slug');
    const grant = this.#grant(capability, 'workspace.create');
    const fresh = await this.#root.mkdir(grant.workspaceId);
    const root = await this.#root.child(grant.workspaceId);
    return root.lock(async () => {
      this.#grant(capability, 'workspace.create');
      if (!fresh) {
        const existing = await readIdentity(root, grant);
        if (existing.owner !== input.owner || existing.slug !== input.slug) throw new WorkspaceError('mint-once', 'Existing identity cannot be renamed or reminted');
        return this.#openLocked(root, capability, grant, existing);
      }
      const id = mintIdentity(input.owner, input.slug);
      const identity = snapshotJson({
        schema: 'rapp-work/identity/1', agent_id: grant.agentId, workspace_id: grant.workspaceId,
        principal_id: grant.principal.id, owner: input.owner, slug: input.slug, body_stream: id,
        memory_stream: `${id}:work`, swarm_stream: `net:${id.slice(id.lastIndexOf(':') + 1)}`,
        created_utc: new Date().toISOString(),
      }) as WorkspaceIdentity;
      await root.writeAtomic('identity.json', canonicalJson(identity));
      await this.#options.fault?.('identity-written', null);
      await root.mkdir('frames');
      for (const family of FAMILIES) await root.mkdir(`frames/${family}`);
      await root.mkdir('artifacts');
      await root.mkdir('imports');
      const manifest: Manifest = {
        schema: 'rapp-work/workspace/1', identity_hash: hashValue(PARTICLE_DOMAIN, identity),
        protocol_revision: { ...AUTHORITY_IDENTITY }, generation: 0,
        streams: {
          body: { stream_id: identity.body_stream, genesis: null, head: null },
          memory: { stream_id: identity.memory_stream, genesis: null, head: null },
          swarm: { stream_id: identity.swarm_stream, genesis: null, head: null },
        },
      };
      await root.writeAtomic('manifest.json', canonicalJson(manifest));
      return this.#openLocked(root, capability, grant, identity);
    }, this.#options.lockTimeoutMs ?? 5000);
  }

  async open(capability: Capability): Promise<AgentWorkspace> {
    const grant = this.#grant(capability, 'workspace.read');
    const root = await this.#root.child(grant.workspaceId);
    return root.lock(async () => this.#openLocked(root, capability, grant, await readIdentity(root, grant)),
      this.#options.lockTimeoutMs ?? 5000);
  }

  async #openLocked(root: PrivateRoot, capability: Capability, grant: CapabilityView, identity: WorkspaceIdentity): Promise<AgentWorkspace> {
    assertOwner(identity, grant);
    const workspace = new AgentWorkspace(WORKSPACE_TOKEN, root, this.#options, capability, identity);
    await workspace.initialize(WORKSPACE_TOKEN);
    return workspace;
  }
}

function assertOwner(identity: WorkspaceIdentity, grant: CapabilityView): void {
  if (identity.agent_id !== grant.agentId || identity.workspace_id !== grant.workspaceId
    || identity.principal_id !== grant.principal.id) throw new WorkspaceError('ownership', 'Workspace is owned by another principal or agent');
}

async function readIdentity(root: PrivateRoot, grant: CapabilityView): Promise<WorkspaceIdentity> {
  let value: unknown;
  try { value = parseCanonicalJson(await root.read('identity.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('mint-once', 'Existing directory has no identity; refuse to remint');
    throw error;
  }
  assertOptions(value, ['schema', 'agent_id', 'workspace_id', 'principal_id', 'owner', 'slug', 'body_stream', 'memory_stream', 'swarm_stream', 'created_utc']);
  if (value.schema !== 'rapp-work/identity/1' || !isLabel(value.owner, 39) || !isLabel(value.slug, 100)
    || !isBodyStream(value.body_stream) || !isUtc(value.created_utc)
    || !value.body_stream.startsWith(`rappid:@${value.owner}/${value.slug}:`)
    || value.memory_stream !== `${value.body_stream}:work`
    || value.swarm_stream !== `net:${value.body_stream.slice(value.body_stream.lastIndexOf(':') + 1)}`) {
    throw new WorkspaceError('identity', 'Corrupt mint-once identity');
  }
  const identity = value as unknown as WorkspaceIdentity;
  assertOwner(identity, grant);
  return identity;
}

export function validateHeads(value: unknown): WorkspaceHeads {
  const snapshot = snapshotJson(value);
  assertOptions(snapshot, FAMILIES);
  const result = {} as Record<StreamFamily, FrameHead | null>;
  for (const family of FAMILIES) {
    result[family] = snapshot[family] === null ? null : validateHead(snapshot[family]);
    if (result[family] && streamFamily(result[family]!.stream_id) !== family) throw new WorkspaceError('heads', 'Head belongs to a different family');
  }
  return Object.freeze(result);
}

function parseManifest(value: unknown, identity: WorkspaceIdentity): Manifest {
  const manifest = snapshotJson(value);
  assertOptions(manifest, ['schema', 'identity_hash', 'protocol_revision', 'generation', 'streams']);
  if (manifest.schema !== 'rapp-work/workspace/1' || manifest.identity_hash !== hashValue(PARTICLE_DOMAIN, identity)
    || canonicalJson(manifest.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)
    || !Number.isSafeInteger(manifest.generation) || (manifest.generation as number) < 0) {
    throw new WorkspaceError('manifest', 'Manifest identity/authority is not trusted');
  }
  assertOptions(manifest.streams, FAMILIES);
  for (const family of FAMILIES) {
    const entry: unknown = manifest.streams[family];
    assertOptions(entry, ['stream_id', 'genesis', 'head']);
    if (entry.stream_id !== identity[`${family}_stream`]) throw new WorkspaceError('manifest', 'Stream belongs to another workspace');
    const genesis = entry.genesis === null ? null : validateHead(entry.genesis);
    const head = entry.head === null ? null : validateHead(entry.head);
    if ((genesis === null) !== (head === null) || (genesis && (genesis.seq !== 0 || genesis.stream_id !== entry.stream_id))
      || (head && head.stream_id !== entry.stream_id)
      || (head?.seq === 0 && canonicalJson(head) !== canonicalJson(genesis))) throw new WorkspaceError('manifest', 'Invalid committed genesis/head');
  }
  return manifest as unknown as Manifest;
}

function pathFor(frame: RappFrame): string {
  return `frames/${streamFamily(frame.stream_id)}/${String(frame.seq).padStart(16, '0')}-${frame.frame_hash}.json`;
}

export class AgentWorkspace {
  readonly identity: WorkspaceIdentity;
  readonly #root: PrivateRoot;
  readonly #options: StoreOptions;
  readonly #capability: Capability;
  readonly #artifacts = new WeakMap<object, ArtifactGrant>();
  #observed: WorkspaceHeads | null = null;

  constructor(token: symbol, root: PrivateRoot, options: StoreOptions, capability: Capability, identity: WorkspaceIdentity) {
    if (token !== WORKSPACE_TOKEN) throw new TypeError('AgentWorkspace must be opened by its authorized store');
    this.#root = root; this.#options = options; this.#capability = capability; this.identity = identity;
    Object.freeze(this);
  }

  #grant(permission: Permission): CapabilityView {
    const grant = this.#options.security.assertCapability(this.#capability, permission, {
      agentId: this.identity.agent_id, workspaceId: this.identity.workspace_id, taskId: null,
    });
    assertOwner(this.identity, grant);
    return grant;
  }

  async initialize(token: symbol): Promise<void> {
    if (token !== WORKSPACE_TOKEN) throw new TypeError('Internal initialization only');
    await this.#recover();
    await this.#scan();
  }

  async #locked<T>(permission: Permission, run: () => Promise<T>): Promise<T> {
    this.#grant(permission);
    return this.#root.lock(async () => {
      const grant = this.#grant(permission);
      const identity = await readIdentity(this.#root, grant);
      if (canonicalJson(identity) !== canonicalJson(this.identity)) throw new WorkspaceError('identity-replaced', 'Identity changed after open');
      await this.#recover();
      return run();
    }, this.#options.lockTimeoutMs ?? 5000);
  }

  async #manifest(): Promise<Manifest> {
    return parseManifest(parseCanonicalJson(await this.#root.read('manifest.json')), this.identity);
  }

  async #scan(): Promise<WorkspaceSnapshot> {
    const manifest = await this.#manifest();
    for (const name of await this.#root.list()) {
      if (!['identity.json', 'manifest.json', 'frames', 'artifacts', 'imports', '.lock', '.transaction.json'].includes(name)) {
        throw new WorkspaceError('unexpected-file', 'Unexpected workspace entry; explicit recovery required');
      }
    }
    const directoryNames = await this.#root.list('frames');
    if (canonicalJson(directoryNames) !== canonicalJson([...FAMILIES].sort())) throw new WorkspaceError('unexpected-file', 'Unexpected or missing stream directory');
    const streams = {} as Record<StreamFamily, VerifiedChain | EmptyStream>;
    const heads = {} as Record<StreamFamily, FrameHead | null>;
    for (const family of FAMILIES) {
      const selected = manifest.streams[family];
      const names = await this.#root.list(`frames/${family}`);
      if (names.length !== (selected.head === null ? 0 : selected.head.seq + 1)) {
        throw new WorkspaceError('stream-completeness', 'Missing, extra, forked or uncommitted frames');
      }
      const values: RappFrame[] = [];
      for (const name of names) {
        if (!/^\d{16}-[0-9a-f]{64}\.json$/.test(name)) throw new WorkspaceError('frame-path', 'Unexpected frame filename');
        const frame = parseCanonicalJson(await this.#root.read(`frames/${family}/${name}`)) as unknown as RappFrame;
        if (pathFor(frame) !== `frames/${family}/${name}`) throw new WorkspaceError('frame-path', 'Filename does not match canonical frame');
        values.push(frame);
      }
      if (selected.head === null) {
        if (this.#observed?.[family] !== null && this.#observed?.[family] !== undefined) throw new WorkspaceError('rollback', 'Previously observed stream disappeared');
        streams[family] = Object.freeze({
          empty: true, streamId: selected.stream_id, frames: Object.freeze([]) as readonly [], head: null,
          trust: Object.freeze({ classification: 'integrity-only', genesis: 'empty', persistedHead: 'empty' }),
        });
        heads[family] = null;
        continue;
      }
      const genesis = selected.genesis!;
      const result = scanChain(values, selectChainTrust({
        genesis: { stream_id: genesis.stream_id, payload_hash: genesis.payload_hash, frame_hash: genesis.frame_hash },
        persistedHead: selected.head, requireCommittedHead: true,
      }), { family, ...(this.#options.signatures === undefined ? {} : { signatures: this.#options.signatures }) });
      if (!result.ok) throw result.error;
      const prior = this.#observed?.[family];
      if (prior) {
        const known = result.frames.find((frame) => frame.seq === prior.seq);
        if (!known || canonicalJson(frameHead(known)) !== canonicalJson(prior)) throw new WorkspaceError('rollback', 'Observed head was rolled back or replaced');
      }
      const evidence = new Set<string>();
      for (const frame of result.frames) {
        if (frame.payload.schema !== EVIDENCE_SCHEMA) continue;
        if (frame.kind !== 'body.pulse') throw new WorkspaceError('evidence-kind', 'Evidence requires body.pulse');
        validateEvidencePayload(frame.payload);
        if (evidence.has(frame.payload_hash)) throw new WorkspaceError('evidence-replay', 'Duplicate evidence particle');
        evidence.add(frame.payload_hash);
      }
      streams[family] = result; heads[family] = result.head;
    }
    this.#observed = Object.freeze(heads);
    const result: WorkspaceSnapshot = Object.freeze({
      identity: this.identity, heads: this.#observed, streams: Object.freeze(streams),
      manifestHash: sha256(canonicalJson(manifest)), generation: manifest.generation,
      trust: Object.freeze({ classification: 'integrity-only', source: 'private-store', factualTruth: false, authorship: false }),
    });
    snapshots.add(result);
    return result;
  }

  scan(): Promise<WorkspaceSnapshot> { return this.#locked('workspace.read', () => this.#scan()); }

  async compareAndAppend(input: { expectedHeads: WorkspaceHeads; frames: readonly RappFrame[] }): Promise<WorkspaceSnapshot> {
    assertOptions(input, ['expectedHeads', 'frames']);
    const expected = validateHeads(input.expectedHeads);
    const frames = arrayItems(input.frames, 256).map((frame) => snapshotJson(frame) as unknown as RappFrame);
    if (frames.length === 0) throw new WorkspaceError('empty-batch', 'A batch must append at least one frame');
    if (frames.reduce((bytes, frame) => bytes + Buffer.byteLength(canonicalJson(frame)), 0) > 16 * 1024 * 1024) {
      throw new WorkspaceError('batch-size', 'Batch exceeds 16 MiB');
    }
    return this.#locked('workspace.append', async () => {
      const before = await this.#scan();
      if (canonicalJson(expected) !== canonicalJson(before.heads)) throw new WorkspaceError('cas-conflict', 'Expected heads are stale; no frames were written');
      const manifest = await this.#manifest();
      const next = JSON.parse(canonicalJson(manifest)) as Manifest;
      if (next.generation === Number.MAX_SAFE_INTEGER) throw new WorkspaceError('generation', 'Manifest generation ceiling');
      next.generation++;
      const evidenceHashes = new Set(before.streams.body.frames.filter((frame) => frame.payload.schema === EVIDENCE_SCHEMA).map((frame) => frame.payload_hash));
      for (const frame of frames) {
        const family = streamFamily(frame.stream_id);
        if (!family) throw new WorkspaceError('frame', 'Unknown stream form');
        const stream = next.streams[family];
        const scanned = scanFrame(frame, {
          head: stream.head, streamId: stream.stream_id,
          ...(this.#options.signatures === undefined ? {} : { signatures: this.#options.signatures }),
        });
        if (!scanned.ok) throw scanned.error;
        if (frame.payload.schema === EVIDENCE_SCHEMA) {
          if (frame.kind !== 'body.pulse') throw new WorkspaceError('evidence-kind', 'Wrong evidence kind');
          validateEvidencePayload(frame.payload);
          if (evidenceHashes.has(frame.payload_hash)) throw new WorkspaceError('evidence-replay', 'Evidence particles are single-use');
          evidenceHashes.add(frame.payload_hash);
        }
        stream.head = frameHead(scanned.frame);
        stream.genesis ??= stream.head;
      }
      const journal: Journal = {
        schema: 'rapp-work/batch/1', previous_manifest_hash: before.manifestHash,
        next_manifest: next, files: frames.map((frame) => ({ path: pathFor(frame), sha256: sha256(canonicalJson(frame)) })),
      };
      let uncertain = false;
      try {
        await this.#root.writeAtomic('.transaction.json', canonicalJson(journal));
        await this.#options.fault?.('journal-written', null);
        for (let i = 0; i < frames.length; i++) {
          await this.#root.writeAtomic(pathFor(frames[i]!), canonicalJson(frames[i]));
          await this.#options.fault?.('frame-written', i);
        }
        await this.#options.fault?.('before-commit', null);
        this.#grant('workspace.append');
        uncertain = true;
        // This one fsynced manifest replacement is the visibility/commit point for every stream.
        await this.#root.writeAtomic('manifest.json', canonicalJson(next), true);
        await this.#options.fault?.('manifest-written', null);
        const after = await this.#scan();
        await this.#options.fault?.('read-back', null);
        await this.#root.remove('.transaction.json');
        return after;
      } catch (error) {
        throw new CommitError(uncertain ? 'unknown' : 'not-committed', error instanceof Error ? error.message : 'Atomic batch failed');
      }
    });
  }

  async #recover(): Promise<void> {
    if (await this.#root.stat('.transaction.json') === null) return;
    const journal = parseCanonicalJson(await this.#root.read('.transaction.json'));
    assertOptions(journal, ['schema', 'previous_manifest_hash', 'next_manifest', 'files']);
    if (journal.schema !== 'rapp-work/batch/1' || typeof journal.previous_manifest_hash !== 'string'
      || !/^[0-9a-f]{64}$/.test(journal.previous_manifest_hash)) throw new WorkspaceError('recovery', 'Untrusted recovery journal');
    const next = parseManifest(journal.next_manifest, this.identity);
    const manifest = await this.#manifest();
    const hash = sha256(canonicalJson(manifest));
    const committed = hash === sha256(canonicalJson(next));
    if (!committed && (hash !== journal.previous_manifest_hash || next.generation !== manifest.generation + 1)) {
      throw new WorkspaceError('recovery-conflict', 'Journal does not continue the committed manifest');
    }
    const files: PendingFile[] = [];
    const seen = new Set<string>();
    for (const item of arrayItems(journal.files, 256)) {
      assertOptions(item, ['path', 'sha256']);
      if (typeof item.path !== 'string' || !/^frames\/(body|memory|swarm)\/\d{16}-[0-9a-f]{64}\.json$/.test(item.path)
        || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) || seen.has(item.path)) {
        throw new WorkspaceError('recovery-path', 'Invalid journal capability path');
      }
      const family = item.path.split('/')[1] as StreamFamily;
      const seq = Number(item.path.split('/')[2]!.slice(0, 16));
      if (!Number.isSafeInteger(seq) || !next.streams[family].head || seq > next.streams[family].head!.seq
        || (!committed && manifest.streams[family].head !== null && seq <= manifest.streams[family].head!.seq)) {
        throw new WorkspaceError('recovery-range', 'Journal attempts to alter committed history');
      }
      seen.add(item.path); files.push(item as unknown as PendingFile);
    }
    if (!files.length) throw new WorkspaceError('recovery', 'Empty journal');
    // Validate the entire recovery set before removing a single file.
    for (const file of files) {
      const stat = await this.#root.stat(file.path);
      if (stat === null) {
        if (committed) throw new WorkspaceError('recovery-missing', 'A committed frame is missing');
      } else if (sha256(await this.#root.read(file.path)) !== file.sha256) {
        throw new WorkspaceError('recovery-corrupt', 'Pending frame does not match its journal');
      }
    }
    if (!committed) for (const file of files) await this.#root.remove(file.path);
    await this.#scan();
    await this.#root.remove('.transaction.json');
  }

  artifact(relativePath: string, rights: readonly ('read' | 'write')[]): ArtifactCapability {
    const path = artifactPath(relativePath);
    const selected = arrayItems(rights, 2);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some((right) => right !== 'read' && right !== 'write')) {
      throw new WorkspaceError('artifact-rights', 'Artifact rights must be explicit');
    }
    for (const right of selected) {
      const grant = this.#grant(right === 'read' ? 'artifact.read' : 'artifact.write');
      if (!grant.resources.includes(`workspace:${this.identity.workspace_id}`) && !grant.resources.includes(`artifact:${path}`)) {
        throw new WorkspaceError('artifact-scope', 'Artifact path is not authorized');
      }
    }
    const handle = Object.freeze(Object.create(null)) as ArtifactCapability;
    this.#artifacts.set(handle, { path, rights: Object.freeze([...selected]) as readonly ('read' | 'write')[] });
    return handle;
  }

  #artifact(capability: ArtifactCapability, right: 'read' | 'write'): ArtifactGrant {
    const grant = this.#artifacts.get(capability);
    if (!grant || !grant.rights.includes(right)) throw new WorkspaceError('artifact-capability', 'Foreign artifact or missing right');
    this.#grant(right === 'read' ? 'artifact.read' : 'artifact.write');
    return grant;
  }

  async writeArtifact(capability: ArtifactCapability, input: Uint8Array): Promise<{ sha256: string; bytes: number }> {
    const grant = this.#artifact(capability, 'write');
    if (!(input instanceof Uint8Array) || input.byteLength > 64 * 1024 * 1024) throw new WorkspaceError('artifact-size', 'Artifact exceeds 64 MiB');
    const bytes = Buffer.from(input);
    return this.#locked('artifact.write', async () => {
      this.#artifact(capability, 'write');
      const relative = `artifacts/${grant.path}`;
      const parts = relative.split('/').slice(0, -1);
      await this.#root.directoryTree(parts.join('/'));
      await this.#root.writeAtomic(relative, bytes);
      const actual = await this.#root.read(relative, 64 * 1024 * 1024);
      if (!actual.equals(bytes)) throw new WorkspaceError('artifact-read-back', 'Artifact read-back mismatch');
      return Object.freeze({ sha256: sha256(actual), bytes: actual.length });
    });
  }

  async readArtifact(capability: ArtifactCapability): Promise<Buffer> {
    const grant = this.#artifact(capability, 'read');
    return this.#locked('artifact.read', () => this.#root.read(`artifacts/${grant.path}`, 64 * 1024 * 1024));
  }
}
