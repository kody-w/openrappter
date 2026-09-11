import type {
  PersistedRappHead,
  OpenRappterEvidenceFrame,
  ProtocolAuthorityIdentity,
  RappFrame,
  RappFrameHead,
  RappSignatureVerifier,
  RappStreamFamily,
  RappTrustAssessment,
  TrustedRappGenesis,
} from '../rapp/index.js';

export const WORKSPACE_SCHEMA = 'rapp-work.workspace/1' as const;
export const WORKSPACE_IDENTITY_SCHEMA = 'rapp-work.identity/1' as const;
export const WORKSPACE_STREAMS = ['body', 'memory', 'swarm'] as const;
export const WORKSPACE_CREATED_EVENT_KIND = 'workspace.created' as const;
export type WorkspaceStream = RappStreamFamily;

/** Derived presentation data, never a durable event or a replacement for frames. */
export type WorkspaceVerification =
  | {
    protocol: RappFrame['spec'];
    status: 'not-scanned' | 'empty';
    scannedFrames: 0;
    trust: null;
  }
  | {
    protocol: RappFrame['spec'];
    status: 'verified';
    scannedFrames: number;
    trust: Readonly<RappTrustAssessment>;
  };

export interface WorkspaceIdentity {
  agentId: string;
  rappid: string;
  createdAt: string;
}

export interface WorkspaceStreamState {
  streamId: string;
  /** Ordered immutable frame addresses; only these objects are committed. */
  frameHashes: string[];
  genesis: TrustedRappGenesis | null;
  head: PersistedRappHead | null;
}

export interface WorkspaceManifest {
  schema: typeof WORKSPACE_SCHEMA;
  identity: WorkspaceIdentity;
  protocolRevision: ProtocolAuthorityIdentity;
  streams: Record<WorkspaceStream, WorkspaceStreamState>;
}

export interface AgentWorkspace {
  agentId: string;
  rootDir: string;
  filesDir: string;
  tasksDir: string;
  manifest: WorkspaceManifest;
  verification: WorkspaceVerification;
}

export interface WorkspaceFrameScan {
  agentId: string;
  stream: WorkspaceStream;
  streamId: string;
  total: number;
  frames: readonly RappFrame[];
  head: RappFrameHead | null;
  /** Empty streams have no verified evidence, so their trust is null. */
  trust: Readonly<RappTrustAssessment> | null;
  verification: WorkspaceVerification;
}

export interface AppendWorkspaceEvidenceInput {
  eventKind: string;
  subject: string;
  dataHash: string;
  referenceHashes?: readonly string[];
  utc?: string;
}

export interface WorkspaceStoreOptions {
  /** Absolute parent of agent workspaces; defaults to openrappterPath('workspaces'). */
  rootDir?: string;
  /** Bounded lock wait. A crashed writer's lock is never stolen automatically. */
  lockTimeoutMs?: number;
  /** Required to ingest or scan nonempty swarm streams; never supplied by RPC callers. */
  verifySwarmSignature?: RappSignatureVerifier;
}

/**
 * Action producers depend on this persistence boundary, not a second event log.
 * State may be projected only from committed, scanned canonical frames.
 */
export interface WorkspaceFramePersistence {
  ensure(agentId: string): Promise<AgentWorkspace>;
  get(agentId: string): Promise<AgentWorkspace | null>;
  frames(agentId: string, stream?: WorkspaceStream): Promise<WorkspaceFrameScan>;
  appendEvidence(agentId: string, input: AppendWorkspaceEvidenceInput): Promise<OpenRappterEvidenceFrame>;
  appendFrame(agentId: string, stream: WorkspaceStream, frame: unknown): Promise<RappFrame>;
}

export type WorkspaceErrorCode =
  | 'invalid-agent-id'
  | 'invalid-path'
  | 'invalid-params'
  | 'unsafe-path'
  | 'integrity'
  | 'not-found'
  | 'busy'
  | 'limit-exceeded'
  | 'swarm-verifier-required';

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`RAPP Work workspace ${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceError';
  }
}
