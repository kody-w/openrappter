import type {
  CommitProof, EffectOutcome, JsonValue, WorkCommitResult, WorkServicePort, WorkspaceScope,
} from "@rapp-work/work-service";

export interface ComputerConfiguration {
  readonly id: string;
  readonly historyScope: WorkspaceScope;
  readonly vmName: string;
  readonly image: string;
  readonly hostKey: string;
  readonly guestUser: string;
  readonly maxExecutionMs: number;
  readonly maxLeaseMs: number;
  readonly maxOutputBytes: number;
  readonly maxArtifactBytes: number;
  readonly configurationRef?: string;
}

export interface VMInspection {
  readonly name: string;
  readonly sourceImage: string;
  readonly operatingSystem: "omarchy";
  readonly state: "running" | "stopped";
  readonly hostMounts: readonly string[];
}

/**
 * Host composition must implement these fixed Tart operations, not a shell API.
 * Source provenance must come from host-owned clone metadata, never a guest claim.
 */
export interface TartControlPort {
  inspect(name: string, signal: AbortSignal): Promise<VMInspection | undefined>;
  clone(sourceImage: string, name: string, signal: AbortSignal): Promise<void>;
  start(name: string, signal: AbortSignal): Promise<void>;
  stop(name: string, signal: AbortSignal): Promise<void>;
  address(name: string, signal: AbortSignal): Promise<string>;
}

export interface GuestSession {
  readonly address: string;
  readonly user: string;
  readonly expectedHostKey: string;
  readonly strictHostKeyChecking: true;
  readonly workspace: WorkspaceScope;
  readonly root: string;
  readonly permit: object;
  readonly intentRef: string;
  readonly signal: AbortSignal;
}

export interface GuestAcknowledgement {
  readonly hostKey: string;
  readonly workspace: WorkspaceScope;
  readonly intentRef: string;
}

/** An SSH/guest-helper adapter enforcing the permit, root, no symlink escape, and byte limits. */
export interface ScopedGuestPort {
  execute(
    session: GuestSession,
    request: { readonly argv: readonly string[]; readonly cwd: string; readonly timeoutMs: number; readonly maxOutputBytes: number; readonly readOnly?: boolean },
  ): Promise<GuestAcknowledgement & { readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  upload(
    session: GuestSession,
    request: { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string; readonly maxBytes: number },
  ): Promise<GuestAcknowledgement & { readonly path: string; readonly sha256: string; readonly bytesWritten: number }>;
  download(
    session: GuestSession,
    request: { readonly path: string; readonly maxBytes: number },
  ): Promise<GuestAcknowledgement & { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string }>;
}

export interface HostComputerLease {
  readonly id: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface ComputerLeaseStorePort {
  /** Globally exclusive for this host. Expired/orphaned leases are never auto-stolen. */
  acquire(computerId: string, owner: WorkspaceScope): Promise<HostComputerLease>;
}

export interface WorkspaceArtifactsPort {
  read(
    capability: object, scope: WorkspaceScope, artifactId: string, maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly sha256: string }>;
  write(
    capability: object, scope: WorkspaceScope, bytes: Uint8Array, sha256: string,
  ): Promise<{ readonly artifactId: string; readonly sha256: string }>;
}

export interface ComputerBrokerDependencies {
  readonly work: WorkServicePort;
  readonly leases: ComputerLeaseStorePort;
  readonly tart: TartControlPort;
  readonly guest: ScopedGuestPort;
  readonly artifacts: WorkspaceArtifactsPort;
  readonly configuration: ComputerConfiguration;
  readonly now?: () => number;
}

declare const leaseBrand: unique symbol;
export interface ComputerLease {
  readonly id: string;
  readonly computerId: string;
  readonly [leaseBrand]: true;
}

export interface BrokerRequest {
  readonly idempotencyKey: string;
  readonly parentIntentRef: string;
  readonly taskId: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export type ComputerReceipt =
  | {
      readonly state: "committed";
      readonly computerId: string;
      readonly commit: Extract<WorkCommitResult, { state: "committed" }>;
    }
  | {
      readonly state: "unresolved";
      readonly computerId: string;
      readonly reason: string;
      readonly commit?: WorkCommitResult;
    };

export type LeaseAcquisition =
  | { readonly state: "acquired"; readonly lease: ComputerLease; readonly receipt: ComputerReceipt }
  | { readonly state: "unresolved"; readonly receipt: ComputerReceipt };

export interface ExecuteRequest extends BrokerRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly readOnly?: boolean;
}

export interface UploadRequest extends BrokerRequest {
  readonly artifactId: string;
  readonly guestPath: string;
}

export interface DownloadRequest extends BrokerRequest {
  readonly guestPath: string;
}

export class ComputerBrokerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ComputerBrokerError";
  }
}

export function computerToolOutcome(receipt: ComputerReceipt): EffectOutcome {
  if (receipt.state !== "committed") throw new ComputerBrokerError("computer_outcome_unresolved");
  const proof: CommitProof = receipt.commit.proof;
  const linked = {
    kind: "computer-receipt", computerId: receipt.computerId,
    intentRef: proof.intentRef, outcomeRef: proof.outcomeRef,
    evidenceRef: proof.evidenceRef, heads: proof.heads as unknown as JsonValue,
  };
  return {
    status: receipt.commit.status, value: receipt.commit.value, receipts: [linked],
    events: [{ type: "computer.receipt.linked", ...linked }],
  };
}
