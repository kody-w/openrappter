import type { RappFrame } from '../rapp/frame.js';
import type { VmRappVerification } from './rapp-evidence.js';

export type VmState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export type VmErrorCode =
  | 'authentication_required'
  | 'rapp_not_wired' | 'rapp_verification_failed'
  | 'not_configured' | 'invalid_configuration'
  | 'unsupported_platform' | 'unsupported_architecture'
  | 'tart_missing' | 'image_missing' | 'command_failed'
  | 'invalid_request' | 'workspace_denied' | 'unsafe_guest_address'
  | 'not_ready' | 'readiness_timeout' | 'process_exited'
  | 'operation_cancelled' | 'shutting_down' | 'exec_busy';

export class VmError extends Error {
  constructor(public readonly code: VmErrorCode, message: string, public readonly evidence?: RappFrame) {
    super(message);
    this.name = 'VmError';
  }
}

export interface VmStatus {
  state: VmState;
  name?: string;
  imageVersion?: string;
  owned: boolean;
  ready: boolean;
  address?: string;
  verification: VmRappVerification;
  evidence?: RappFrame;
  error?: { code: VmErrorCode; message: string };
}

export interface VmWorkspaceIdentity {
  agentId: string;
  workspaceId: string;
}

export interface VmWorkspace extends VmWorkspaceIdentity {
  hostPath: string;
  guestPath: string;
}

/** Only host code may register identities or choose their backing directories. */
export interface VmWorkspaces {
  resolve(identity: VmWorkspaceIdentity, cause?: RappFrame): Promise<VmWorkspace>;
}

export interface VmExecRequest extends VmWorkspaceIdentity {
  argv: string[];
  /** Relative to this identity's guest workspace, never a host directory. */
  cwd?: string;
  timeoutMs?: number;
}

export interface VmExecResult extends VmWorkspaceIdentity {
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  evidence: RappFrame;
  verification: VmRappVerification;
}

export interface VmSupervisor {
  status(): Promise<VmStatus>;
  start(): Promise<VmStatus>;
  stop(): Promise<VmStatus>;
  restart(): Promise<VmStatus>;
  waitReady(): Promise<VmStatus>;
  exec(request: VmExecRequest): Promise<VmExecResult>;
  getFrames(): readonly RappFrame[];
  /** Cancel work and stop only the foreground Tart child this instance launched. */
  shutdown(): Promise<void>;
}
