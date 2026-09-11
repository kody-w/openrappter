import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { mintTail } from '../identity/name.js';
import { openrappterPath } from '../infra/openrappter-home.js';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  OPENRAPPTER_EVIDENCE_PROFILE,
  RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  RAPP_FRAME_SPEC,
  buildOpenRappterEvidencePayload,
  buildRappEvidenceFrame,
  createRappSwarmStreamProfile,
  isRappFrameUtc,
  protocolAuthorityIdentity,
  rappFrameToJson,
  selectRappChainTrustPolicy,
  verifyRappFrame,
  verifyRappFrameChain,
  type OpenRappterEvidenceFrame,
  type RappFrame,
  type RappFrameHead,
  type RappFrameProfile,
} from '../rapp/index.js';
import { formatRappid, rappidHex } from '../rappids/identity.js';
import {
  RAPP_PARTICLE_DOMAIN,
  parseRappJson,
  rappCanonicalJson,
  rappH,
  snapshotRappJsonValue,
} from '../rappids/canonical.js';
import type { JsonObject } from '../rappids/types.js';
import {
  directoryTree,
  publishFrame,
  readPrivateFile,
  replaceManifest,
  requireDirectory,
  resolveContentPath,
  syncDirectory,
  validateWorkspaceAgentId,
  validateWorkspaceRelativePath,
  validateWorkspaceRoot,
  withWorkspaceLock,
  writePrivateFile,
} from './filesystem.js';
import {
  WORKSPACE_IDENTITY_SCHEMA,
  WORKSPACE_CREATED_EVENT_KIND,
  WORKSPACE_SCHEMA,
  WORKSPACE_STREAMS,
  WorkspaceError,
  type AgentWorkspace,
  type AppendWorkspaceEvidenceInput,
  type WorkspaceFrameScan,
  type WorkspaceFramePersistence,
  type WorkspaceIdentity,
  type WorkspaceManifest,
  type WorkspaceStoreOptions,
  type WorkspaceStream,
  type WorkspaceStreamState,
} from './types.js';

export const WORKSPACE_MAX_FRAME_BYTES = 1024 * 1024;
export const WORKSPACE_MAX_FRAMES_PER_STREAM = 10_000;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 4096;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().length(24).refine(isRappFrameUtc, 'expected RAPP/1 UTC milliseconds');
const genesisSchema = z.object({
  streamId: z.string(), frameHash: hash, payloadHash: hash,
}).strict();
const headSchema = z.object({
  streamId: z.string(), seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), frameHash: hash,
}).strict();
const streamSchema = z.object({
  streamId: z.string(),
  frameHashes: z.array(hash).max(WORKSPACE_MAX_FRAMES_PER_STREAM),
  genesis: genesisSchema.nullable(),
  head: headSchema.nullable(),
}).strict();
const privateIdentitySchema = z.object({
  schema: z.literal(WORKSPACE_IDENTITY_SCHEMA),
  agentId: z.string(),
  createdAt: timestamp,
  tail: hash,
}).strict();
const manifestSchema = z.object({
  schema: z.literal(WORKSPACE_SCHEMA),
  identity: z.object({ agentId: z.string(), rappid: z.string(), createdAt: timestamp }).strict(),
  protocolRevision: z.object({ revision: z.string(), frame_hash: hash, payload_hash: hash }).strict(),
  streams: z.object({ body: streamSchema, memory: streamSchema, swarm: streamSchema }).strict(),
}).strict();
const evidenceSchema = z.object({
  eventKind: z.string().max(129),
  subject: z.string().min(1).max(16_384),
  dataHash: hash,
  referenceHashes: z.array(hash).max(1024).optional(),
  utc: timestamp.optional(),
}).strict();

interface LoadedWorkspace {
  workspace: AgentWorkspace;
  manifestBytes: Buffer;
  identityBytes: Buffer;
}

interface PreparedAppend {
  frame: RappFrame;
  frameBytes: Buffer;
  manifest: WorkspaceManifest;
  manifestBytes: Buffer;
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(rappCanonicalJson(snapshotRappJsonValue(value)) + '\n', 'utf8');
}

function document<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  try {
    return schema.parse(parseRappJson(utf8.decode(bytes)));
  } catch (error) {
    throw new WorkspaceError('integrity', `${label} is not a valid workspace document`, error);
  }
}

function streamOf(value: unknown): WorkspaceStream {
  if (!WORKSPACE_STREAMS.includes(value as WorkspaceStream)) {
    throw new WorkspaceError('invalid-params', 'stream must be body, memory, or swarm');
  }
  return value as WorkspaceStream;
}

function identities(agentId: string, tail: string, createdAt: string): {
  identity: WorkspaceIdentity;
  streams: Record<WorkspaceStream, string>;
} {
  const hex = rappidHex(tail);
  const rappid = formatRappid({ owner: 'rapp-work', name: agentId, hex });
  return {
    identity: { agentId, rappid, createdAt },
    streams: { body: rappid, memory: `${rappid}:memory`, swarm: `net:${hex}` },
  };
}

function frameHead(frame: RappFrame): RappFrameHead {
  return {
    stream_id: frame.stream_id, seq: frame.seq, utc: frame.utc,
    payload_hash: frame.payload_hash, frame_hash: frame.frame_hash,
  };
}

function framePath(workspace: AgentWorkspace, stream: WorkspaceStream, seq: number, frameHash: string): string {
  return path.join(workspace.rootDir, 'streams', stream, `${String(seq).padStart(16, '0')}-${frameHash}.json`);
}

function creationHash(manifest: WorkspaceManifest): string {
  return rappH(RAPP_PARTICLE_DOMAIN, {
    identity: { ...manifest.identity },
    protocolRevision: { ...manifest.protocolRevision },
    streams: {
      body: manifest.streams.body.streamId,
      memory: manifest.streams.memory.streamId,
      swarm: manifest.streams.swarm.streamId,
    },
  });
}

function checkLifecycle(frames: readonly RappFrame[], manifest: WorkspaceManifest): void {
  const creation = frames[0];
  if (
    creation === undefined
    || creation.payload.event_kind !== WORKSPACE_CREATED_EVENT_KIND
    || creation.payload.subject !== manifest.identity.rappid
    || creation.utc !== manifest.identity.createdAt
    || creation.payload.data_hash !== creationHash(manifest)
    || !Array.isArray(creation.payload.reference_hashes)
    || creation.payload.reference_hashes.length !== 0
  ) {
    throw new WorkspaceError('integrity', 'workspace creation is not bound to verified RAPP/1 evidence; unframed workspaces require explicit migration');
  }
  if (frames.slice(1).some((frame) => frame.payload.event_kind === WORKSPACE_CREATED_EVENT_KIND)) {
    throw new WorkspaceError('integrity', 'workspace.created is reserved for the original creation frame');
  }
}

function workspaceView(id: string, directory: string, manifest: WorkspaceManifest): AgentWorkspace {
  return {
    agentId: id, rootDir: directory,
    filesDir: path.join(directory, 'files'), tasksDir: path.join(directory, 'tasks'), manifest,
    verification: { protocol: RAPP_FRAME_SPEC, status: 'not-scanned', scannedFrames: 0, trust: null },
  };
}

function emptyScan(workspace: AgentWorkspace, stream: WorkspaceStream): WorkspaceFrameScan {
  return {
    agentId: workspace.agentId, stream, streamId: workspace.manifest.streams[stream].streamId,
    total: 0, frames: [], head: null, trust: null,
    verification: { protocol: RAPP_FRAME_SPEC, status: 'empty', scannedFrames: 0, trust: null },
  };
}

function checkedManifest(
  manifest: WorkspaceManifest,
  identity: z.infer<typeof privateIdentitySchema>,
  agentId: string,
): void {
  const expected = identities(agentId, identity.tail, identity.createdAt);
  if (
    identity.agentId !== agentId
    || !jsonBytes(manifest.identity).equals(jsonBytes(expected.identity))
    || !jsonBytes(manifest.protocolRevision).equals(jsonBytes(protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY)))
  ) {
    throw new WorkspaceError('integrity', 'workspace identity or protocol authority does not match its manifest');
  }
  for (const stream of WORKSPACE_STREAMS) {
    const state = manifest.streams[stream];
    if (state.streamId !== expected.streams[stream]) {
      throw new WorkspaceError('integrity', `${stream} stream does not belong to this agent identity`);
    }
    if (state.frameHashes.length === 0) {
      if (state.genesis !== null || state.head !== null) {
        throw new WorkspaceError('integrity', `empty ${stream} stream has committed anchors`);
      }
    } else if (
      state.genesis === null || state.head === null
      || state.genesis.streamId !== state.streamId || state.head.streamId !== state.streamId
      || state.genesis.frameHash !== state.frameHashes[0]
      || state.head.frameHash !== state.frameHashes[state.frameHashes.length - 1]
      || state.head.seq !== state.frameHashes.length - 1
      || new Set(state.frameHashes).size !== state.frameHashes.length
    ) {
      throw new WorkspaceError('integrity', `${stream} committed frame index disagrees with its genesis or head`);
    }
  }
}

/**
 * Local, private per-agent storage. Immutable frame objects are prepared first;
 * one fsynced manifest rename commits their addresses and trusted checkpoints.
 * Readers use that snapshot, never adopt orphan objects, and never repair damage.
 */
export class WorkspaceStore implements WorkspaceFramePersistence {
  private readonly configuredRoot?: string;
  private readonly lockTimeoutMs: number;
  private readonly swarmProfile?: Readonly<RappFrameProfile<JsonObject, string>>;

  constructor(options: WorkspaceStoreOptions = {}) {
    this.configuredRoot = options.rootDir === undefined ? undefined : validateWorkspaceRoot(options.rootDir);
    const timeout = options.lockTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new WorkspaceError('invalid-params', 'lockTimeoutMs must be an integer between 1 and 60000');
    }
    this.lockTimeoutMs = timeout;
    if (options.verifySwarmSignature !== undefined) {
      this.swarmProfile = createRappSwarmStreamProfile(options.verifySwarmSignature);
    }
  }

  get rootDir(): string {
    return this.configuredRoot ?? validateWorkspaceRoot(openrappterPath('workspaces'));
  }

  async list(): Promise<AgentWorkspace[]> {
    const root = this.rootDir;
    if (!await directoryTree(root, root)) return [];
    const entries = (await fs.readdir(root)).sort();
    const result: AgentWorkspace[] = [];
    for (const entry of entries) {
      if (entry === '.locks' || entry.startsWith('.create-')) continue;
      const loaded = await this.load(root, validateWorkspaceAgentId(entry));
      if (loaded !== null) result.push(loaded.workspace);
    }
    return result;
  }

  async get(agentId: string): Promise<AgentWorkspace | null> {
    const id = validateWorkspaceAgentId(agentId);
    return (await this.load(this.rootDir, id))?.workspace ?? null;
  }

  async ensure(agentId: string): Promise<AgentWorkspace> {
    const id = validateWorkspaceAgentId(agentId);
    const root = this.rootDir;
    await directoryTree(root, root, true);
    return withWorkspaceLock(root, id, this.lockTimeoutMs, async () => {
      const existing = await this.load(root, id);
      if (existing !== null) {
        await this.scan(root, existing.workspace, 'body');
        return existing.workspace;
      }
      const staging = path.join(root, `.create-${id}-${randomUUID()}`);
      const destination = path.join(root, id);
      try {
        await fs.mkdir(staging, { mode: 0o700 });
        for (const directory of ['files', 'tasks', 'streams', ...WORKSPACE_STREAMS.map((stream) => `streams/${stream}`)]) {
          await directoryTree(path.join(staging, directory), root, true);
        }
        const privateIdentity = {
          schema: WORKSPACE_IDENTITY_SCHEMA,
          agentId: id,
          createdAt: new Date().toISOString(),
          tail: mintTail(),
        };
        const { identity, streams } = identities(id, privateIdentity.tail, privateIdentity.createdAt);
        const state = (stream: WorkspaceStream): WorkspaceStreamState => ({
          streamId: streams[stream], frameHashes: [], genesis: null, head: null,
        });
        const manifest: WorkspaceManifest = {
          schema: WORKSPACE_SCHEMA,
          identity,
          protocolRevision: { ...protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY) },
          streams: { body: state('body'), memory: state('memory'), swarm: state('swarm') },
        };
        const workspace = workspaceView(id, staging, manifest);
        const creation = buildRappEvidenceFrame({
          streamId: streams.body,
          utc: identity.createdAt,
          eventKind: WORKSPACE_CREATED_EVENT_KIND,
          subject: identity.rappid,
          dataHash: creationHash(manifest),
          head: null,
        });
        const prepared = this.prepareAppend(workspace, 'body', emptyScan(workspace, 'body'), creation);
        await writePrivateFile(path.join(staging, 'identity.json'), jsonBytes(privateIdentity), root);
        await publishFrame(framePath(workspace, 'body', creation.seq, creation.frame_hash), prepared.frameBytes, root);
        await writePrivateFile(path.join(staging, 'manifest.json'), prepared.manifestBytes, root);
        await this.scan(root, workspaceView(id, staging, prepared.manifest), 'body');
        await syncDirectory(staging);
        await requireDirectory(root, root);
        await fs.rename(staging, destination);
        await syncDirectory(root);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
      return (await this.requireWorkspace(root, id)).workspace;
    });
  }

  async resolvePath(agentId: string, area: 'files' | 'tasks', relativePath: string): Promise<string> {
    const id = validateWorkspaceAgentId(agentId);
    if (area !== 'files' && area !== 'tasks') {
      throw new WorkspaceError('invalid-path', 'content area must be files or tasks');
    }
    const relative = validateWorkspaceRelativePath(relativePath);
    const root = this.rootDir;
    const { workspace } = await this.requireWorkspace(root, id);
    await this.scan(root, workspace, 'body');
    return resolveContentPath(root, path.join(workspace.rootDir, area), relative);
  }

  async frames(agentId: string, stream: WorkspaceStream = 'body'): Promise<WorkspaceFrameScan> {
    const id = validateWorkspaceAgentId(agentId);
    const selectedStream = streamOf(stream);
    const root = this.rootDir;
    const { workspace } = await this.requireWorkspace(root, id);
    if (selectedStream !== 'body') await this.scan(root, workspace, 'body');
    return this.scan(root, workspace, selectedStream);
  }

  async appendEvidence(agentId: string, input: AppendWorkspaceEvidenceInput): Promise<OpenRappterEvidenceFrame> {
    const id = validateWorkspaceAgentId(agentId);
    const parsed = evidenceSchema.safeParse(input);
    if (!parsed.success) throw new WorkspaceError('invalid-params', 'invalid evidence options', parsed.error);
    const options = parsed.data;
    if (options.eventKind === WORKSPACE_CREATED_EVENT_KIND) {
      throw new WorkspaceError('invalid-params', 'workspace.created can only be emitted by atomic workspace creation');
    }
    try {
      buildOpenRappterEvidencePayload({
        eventKind: options.eventKind, subject: options.subject,
        dataHash: options.dataHash, referenceHashes: options.referenceHashes,
      });
    } catch (error) {
      throw new WorkspaceError('invalid-params', 'evidence does not satisfy the canonical evidence profile', error);
    }
    return this.append(id, 'body', (workspace, scan) => {
      try {
        return buildRappEvidenceFrame({
          streamId: workspace.manifest.streams.body.streamId,
          utc: options.utc ?? new Date().toISOString(),
          eventKind: options.eventKind,
          subject: options.subject,
          dataHash: options.dataHash,
          referenceHashes: options.referenceHashes,
          head: scan.head,
        });
      } catch (error) {
        throw new WorkspaceError('integrity', 'cannot emit a canonical evidence continuation', error);
      }
    }) as Promise<OpenRappterEvidenceFrame>;
  }

  /** Ingest an already-issued frame; this never implements a second protocol builder. */
  async appendFrame(agentId: string, stream: WorkspaceStream, value: unknown): Promise<RappFrame> {
    const id = validateWorkspaceAgentId(agentId);
    const selectedStream = streamOf(stream);
    this.profile(selectedStream);
    let snapshot: unknown;
    try {
      snapshot = snapshotRappJsonValue(value);
    } catch (error) {
      throw new WorkspaceError('invalid-params', 'frame is outside the canonical RAPP/1 input domain', error);
    }
    return this.append(id, selectedStream, () => snapshot);
  }

  private profile(stream: WorkspaceStream): Readonly<RappFrameProfile<JsonObject, string>> {
    if (stream === 'body') return OPENRAPPTER_EVIDENCE_PROFILE;
    if (stream === 'memory') return RAPP_ACCEPTED_MEMORY_STREAM_PROFILE;
    if (this.swarmProfile === undefined) {
      throw new WorkspaceError('swarm-verifier-required', 'nonempty swarm streams require an explicitly configured signature verifier');
    }
    return this.swarmProfile;
  }

  private async load(root: string, id: string): Promise<LoadedWorkspace | null> {
    const directory = path.join(root, id);
    if (!await directoryTree(directory, root)) return null;
    const manifestBytes = await readPrivateFile(path.join(directory, 'manifest.json'), root, MAX_MANIFEST_BYTES, true);
    const identityBytes = await readPrivateFile(path.join(directory, 'identity.json'), root, MAX_IDENTITY_BYTES);
    const manifest = document(manifestBytes, manifestSchema, 'manifest.json');
    const identity = document(identityBytes, privateIdentitySchema, 'identity.json');
    checkedManifest(manifest, identity, id);
    for (const component of ['files', 'tasks', ...WORKSPACE_STREAMS.map((stream) => `streams/${stream}`)]) {
      await requireDirectory(path.join(directory, component), root);
    }
    return {
      workspace: workspaceView(id, directory, manifest),
      manifestBytes,
      identityBytes,
    };
  }

  private async requireWorkspace(root: string, id: string): Promise<LoadedWorkspace> {
    const loaded = await this.load(root, id);
    if (loaded === null) throw new WorkspaceError('not-found', `workspace does not exist for ${id}; ensure it first`);
    return loaded;
  }

  private async scan(root: string, workspace: AgentWorkspace, stream: WorkspaceStream): Promise<WorkspaceFrameScan> {
    const state = workspace.manifest.streams[stream];
    const base = { agentId: workspace.agentId, stream, streamId: state.streamId, total: state.frameHashes.length };
    if (state.frameHashes.length === 0) {
      if (stream === 'body') checkLifecycle([], workspace.manifest);
      return emptyScan(workspace, stream);
    }
    const profile = this.profile(stream);
    const values: unknown[] = [];
    for (const [seq, frameHash] of state.frameHashes.entries()) {
      const bytes = await readPrivateFile(framePath(workspace, stream, seq, frameHash), root, WORKSPACE_MAX_FRAME_BYTES);
      try {
        values.push(parseRappJson(utf8.decode(bytes)));
      } catch (error) {
        throw new WorkspaceError('integrity', `${stream} frame ${seq} is not canonical-domain RAPP/1 JSON`, error);
      }
    }
    const checked = verifyRappFrameChain(values, profile, selectRappChainTrustPolicy({
      trustedGenesis: state.genesis!, persistedHead: state.head,
    }));
    if (!checked.ok) throw new WorkspaceError('integrity', `${stream} chain verification failed: ${checked.error.message}`, checked.error);
    for (const [index, frame] of checked.frames.entries()) {
      if (frame.seq !== index || frame.frame_hash !== state.frameHashes[index]) {
        throw new WorkspaceError('integrity', `${stream} frame ${index} conflicts with its committed address`);
      }
    }
    if (stream === 'body') checkLifecycle(checked.frames, workspace.manifest);
    return {
      ...base, frames: checked.frames, head: frameHead(checked.head), trust: checked.trust,
      verification: {
        protocol: RAPP_FRAME_SPEC, status: 'verified',
        scannedFrames: checked.frames.length, trust: checked.trust,
      },
    };
  }

  private prepareAppend(
    workspace: AgentWorkspace,
    stream: WorkspaceStream,
    scan: WorkspaceFrameScan,
    value: unknown,
  ): PreparedAppend {
    const state = workspace.manifest.streams[stream];
    if (scan.total >= WORKSPACE_MAX_FRAMES_PER_STREAM) {
      throw new WorkspaceError('limit-exceeded', `stream has reached the ${WORKSPACE_MAX_FRAMES_PER_STREAM} frame safety bound`);
    }
    const profile = this.profile(stream);
    const emitted = verifyRappFrame(value, profile, { head: scan.head, streamIdOfRecord: state.streamId });
    if (!emitted.ok) throw new WorkspaceError('integrity', `new frame verification failed: ${emitted.error.message}`, emitted.error);
    const frame = emitted.frame;
    const frameBytes = jsonBytes(rappFrameToJson(frame));
    if (frameBytes.length > WORKSPACE_MAX_FRAME_BYTES) {
      throw new WorkspaceError('limit-exceeded', `frame exceeds ${WORKSPACE_MAX_FRAME_BYTES} bytes`);
    }
    const genesis = state.genesis ?? {
      streamId: state.streamId, frameHash: frame.frame_hash, payloadHash: frame.payload_hash,
    };
    // Verify serialized emitted bytes together with the existing chain before any publication.
    const candidate = verifyRappFrameChain(
      [...scan.frames, parseRappJson(utf8.decode(frameBytes))],
      profile,
      selectRappChainTrustPolicy({ trustedGenesis: genesis, persistedHead: state.head }),
    );
    if (!candidate.ok) throw new WorkspaceError('integrity', `appended chain verification failed: ${candidate.error.message}`, candidate.error);
    if (stream === 'body') checkLifecycle(candidate.frames, workspace.manifest);

    const manifest: WorkspaceManifest = {
      ...workspace.manifest,
      streams: {
        ...workspace.manifest.streams,
        [stream]: {
          streamId: state.streamId,
          frameHashes: [...state.frameHashes, frame.frame_hash],
          genesis,
          head: { streamId: state.streamId, seq: frame.seq, frameHash: frame.frame_hash },
        },
      },
    };
    const manifestBytes = jsonBytes(manifest);
    if (manifestBytes.length > MAX_MANIFEST_BYTES) {
      throw new WorkspaceError('limit-exceeded', 'workspace manifest is too large');
    }
    return { frame: candidate.head, frameBytes, manifest, manifestBytes };
  }

  private async append(
    id: string,
    stream: WorkspaceStream,
    emit: (workspace: AgentWorkspace, scan: WorkspaceFrameScan) => unknown,
  ): Promise<RappFrame> {
    const root = this.rootDir;
    if (!await directoryTree(root, root)) throw new WorkspaceError('not-found', `workspace does not exist for ${id}; ensure it first`);
    return withWorkspaceLock(root, id, this.lockTimeoutMs, async () => {
      const loaded = await this.requireWorkspace(root, id);
      const { workspace } = loaded;
      if (stream !== 'body') await this.scan(root, workspace, 'body');
      const scan = await this.scan(root, workspace, stream);
      const prepared = this.prepareAppend(workspace, stream, scan, emit(workspace, scan));
      const { frame } = prepared;
      await publishFrame(framePath(workspace, stream, frame.seq, frame.frame_hash), prepared.frameBytes, root);
      const currentManifest = await readPrivateFile(path.join(workspace.rootDir, 'manifest.json'), root, MAX_MANIFEST_BYTES);
      const currentIdentity = await readPrivateFile(path.join(workspace.rootDir, 'identity.json'), root, MAX_IDENTITY_BYTES);
      if (!currentManifest.equals(loaded.manifestBytes) || !currentIdentity.equals(loaded.identityBytes)) {
        throw new WorkspaceError('integrity', 'workspace control documents changed outside the writer lock');
      }
      await replaceManifest(path.join(workspace.rootDir, 'manifest.json'), prepared.manifestBytes, root);
      return frame;
    });
  }
}
