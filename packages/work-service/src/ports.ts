export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface WorkspaceScope {
  readonly agentId: string;
  readonly workspaceId: string;
}

export type Stream = "body" | "memory" | "swarm";
export type Heads = Readonly<Record<Stream, string | null>>;

export interface Resource {
  readonly kind: "agent" | "workspace" | "task" | "run" | "computer" | "artifact";
  readonly id: string;
}

export interface WorkCommand {
  readonly scope: WorkspaceScope;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly payload: JsonValue;
  readonly resources: readonly Resource[];
}

export interface VerifiedFrame {
  readonly ref: string;
  readonly stream: Stream;
  readonly value: JsonValue;
}

export interface VerifiedHistory {
  readonly scope: WorkspaceScope;
  readonly heads: Heads;
  readonly frames: readonly VerifiedFrame[];
}

/**
 * Composition-root adapter for @rapp-work/rapp1. scan must reject invalid,
 * uncommitted, truncated, forked, wrong-owner, or otherwise untrusted chains.
 * Neither an index nor a caller-provided "verified" flag implements this port.
 */
export interface CanonicalPort {
  digest(value: JsonValue): string;
  scan(raw: unknown, scope: WorkspaceScope): VerifiedHistory | Promise<VerifiedHistory>;
}

export interface CommitJournal {
  readCommitted(): Promise<unknown>;
  /** Durable append with all-stream head CAS; never acknowledge buffered writes. */
  append(events: readonly JsonObject[], expectedHeads: Heads): Promise<void>;
}

/** Adapter for the workspace-store public lock, committed-read, and batch-CAS API. */
export interface WorkspaceHistoryPort {
  withExclusive<T>(
    capability: object,
    scope: WorkspaceScope,
    action: (journal: CommitJournal) => Promise<T>,
  ): Promise<T>;
}

export interface AuthorizationRequest {
  readonly command: WorkCommand;
  readonly commandHash: string;
  readonly heads: Heads;
}

/** Adapter for security's authenticated capabilities and one-use scoped permits. */
export interface WorkAuthorizationPort {
  authorizeRead(capability: object, scope: WorkspaceScope): Promise<void>;
  authorizeCommand(
    capability: object,
    request: AuthorizationRequest,
  ): Promise<{ readonly principalId: string }>;
  issuePermit(
    capability: object,
    request: AuthorizationRequest & { readonly intentRef: string },
  ): Promise<object>;
}

export type TerminalStatus = "succeeded" | "failed" | "cancelled" | "denied";

export interface EffectOutcome {
  readonly status: TerminalStatus;
  readonly value: JsonValue;
  readonly receipts: readonly JsonObject[];
  readonly events: readonly JsonObject[];
}

export interface AuthorizedEffectContext {
  readonly permit: object;
  readonly command: WorkCommand;
  readonly commandHash: string;
  readonly intentRef: string;
  readonly signal: AbortSignal;
}

export type AuthorizedEffect = (context: AuthorizedEffectContext) => Promise<EffectOutcome>;

export interface CommitProof {
  readonly intentRef: string;
  readonly outcomeRef: string;
  readonly evidenceRef: string;
  readonly heads: Heads;
}

export interface CommittedCommand {
  readonly state: "committed";
  readonly command: WorkCommand;
  readonly commandHash: string;
  readonly principalId: string;
  readonly status: TerminalStatus;
  readonly value: JsonValue;
  readonly events: readonly JsonObject[];
  readonly receipts: readonly JsonObject[];
  readonly proof: CommitProof;
}

export type UnresolvedReason =
  | "intent-only"
  | "outcome-unproven"
  | "persistence-uncertain"
  | "effect-uncertain";

export interface UnresolvedCommand {
  readonly state: "unresolved";
  readonly command: WorkCommand;
  readonly commandHash: string;
  readonly principalId: string;
  readonly intentRef: string;
  readonly reason: UnresolvedReason;
}

export interface WorkSnapshot {
  readonly scope: WorkspaceScope;
  readonly heads: Heads;
  readonly commands: readonly (CommittedCommand | UnresolvedCommand)[];
}

export type WorkCommitResult =
  | (CommittedCommand & { readonly replayed: boolean })
  | {
      readonly state: "unresolved";
      readonly command: WorkCommand;
      readonly commandHash: string;
      readonly intentRef?: string;
      readonly reason: UnresolvedReason;
      readonly replayed: boolean;
    };

export interface ProjectionReducer<T> {
  initial(): T;
  apply(value: T, committed: CommittedCommand): T;
}

export interface VerifiedProjection<T> {
  readonly value: T;
  readonly heads: Heads;
  readonly proofs: readonly CommitProof[];
}

export interface WorkServicePort {
  read(capability: object, scope: WorkspaceScope): Promise<WorkSnapshot>;
  project<T>(
    capability: object,
    scope: WorkspaceScope,
    reducer: ProjectionReducer<T>,
  ): Promise<VerifiedProjection<T>>;
  commit(
    capability: object,
    command: WorkCommand,
    effect: AuthorizedEffect,
    options?: { readonly signal?: AbortSignal },
  ): Promise<WorkCommitResult>;
}
