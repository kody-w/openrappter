import type { ChatEnvelope } from '../gateway/chat-envelope.js';
import type { ChatRequest } from '../gateway/chat-request.js';

export const RAPP_CHAT_PROTOCOL = 'rapp-chat/1.0' as const;
export const RAPP_PARTICIPANT_HEALTH_SCHEMA = 'rapp-participant-health/1.0' as const;

export interface RappParticipantCapabilities {
  chat: boolean;
  health: boolean;
  history: boolean;
  tools: boolean;
  streaming: boolean;
  voice: boolean;
  attachments: boolean;
  /** Capability names unknown to this version, retained for forward compatibility. */
  extensions: readonly string[];
}

export interface RappHarnessMetadata {
  /** Implementation name only; never a participant identity or registry key. */
  name: string;
  displayName?: string;
  version?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface RappParticipantDescriptor {
  /** Stable logical identity. Null means a legacy peer has not published one. */
  rappid: string | null;
  /** One process incarnation. Null means a legacy peer has not published one. */
  liveId: string | null;
  /** Serving process ID, separate from both stable and live identity. */
  pid: number | null;
  /** Deployment implementation details, never the primary identity. */
  harness: Readonly<RappHarnessMetadata> | null;
  /** Canonical HTTP base URL without a trailing slash. */
  endpoint: string;
  protocol: typeof RAPP_CHAT_PROTOCOL;
  /** The provider or broker authoritative for model selection. */
  modelAuthority: string | null;
  capabilities: Readonly<RappParticipantCapabilities>;
}

export interface RappParticipantStatus {
  status: 'ok' | 'degraded';
  descriptor: Readonly<RappParticipantDescriptor>;
  checkedAt: string;
}

export interface RappParticipantChatRequest extends ChatRequest {
  idempotencyKey?: string;
}

export interface RappParticipant {
  readonly descriptor: Readonly<RappParticipantDescriptor>;
  status(signal?: AbortSignal): Promise<RappParticipantStatus>;
  chat(
    request: RappParticipantChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope>;
}

export type RappParticipantOperation = 'health' | 'chat';

export type RappParticipantErrorCode =
  | 'aborted'
  | 'timeout'
  | 'http'
  | 'transport'
  | 'protocol'
  | 'identity-drift';

export class RappParticipantError extends Error {
  readonly code: RappParticipantErrorCode;
  readonly operation: RappParticipantOperation;
  readonly endpoint: string;

  constructor(
    code: RappParticipantErrorCode,
    operation: RappParticipantOperation,
    endpoint: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RappParticipantError';
    this.code = code;
    this.operation = operation;
    this.endpoint = endpoint;
  }
}

export class RappParticipantAbortedError extends RappParticipantError {
  constructor(operation: RappParticipantOperation, endpoint: string) {
    super('aborted', operation, endpoint, `RAPP participant ${operation} request was cancelled.`);
    this.name = 'RappParticipantAbortedError';
  }
}

export class RappParticipantTimeoutError extends RappParticipantError {
  readonly timeoutMs: number;

  constructor(operation: RappParticipantOperation, endpoint: string, timeoutMs: number) {
    super(
      'timeout',
      operation,
      endpoint,
      `RAPP participant ${operation} request timed out after ${timeoutMs}ms at ${endpoint}.`,
    );
    this.name = 'RappParticipantTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class RappParticipantHttpError extends RappParticipantError {
  readonly status: number;

  constructor(operation: RappParticipantOperation, endpoint: string, status: number) {
    super(
      'http',
      operation,
      endpoint,
      `RAPP participant ${operation} request failed with HTTP ${status} at ${endpoint}.`,
    );
    this.name = 'RappParticipantHttpError';
    this.status = status;
  }
}

export class RappParticipantTransportError extends RappParticipantError {
  constructor(operation: RappParticipantOperation, endpoint: string, cause: unknown) {
    super(
      'transport',
      operation,
      endpoint,
      `RAPP participant ${operation} request could not reach ${endpoint}.`,
      cause,
    );
    this.name = 'RappParticipantTransportError';
  }
}

export class RappParticipantProtocolError extends RappParticipantError {
  readonly detail: string;

  constructor(operation: RappParticipantOperation, endpoint: string, detail: string) {
    super(
      'protocol',
      operation,
      endpoint,
      `RAPP participant ${operation} protocol violation at ${endpoint}: ${detail}`,
    );
    this.name = 'RappParticipantProtocolError';
    this.detail = detail;
  }
}

export class RappParticipantIdentityDriftError extends RappParticipantError {
  readonly axis: 'rappid' | 'liveId';
  readonly expected: string;
  readonly actual: string;

  constructor(
    operation: RappParticipantOperation,
    endpoint: string,
    axis: 'rappid' | 'liveId',
    expected: string,
    actual: string,
  ) {
    super(
      'identity-drift',
      operation,
      endpoint,
      `RAPP participant ${axis} changed between health and ${operation} at ${endpoint}.`,
    );
    this.name = 'RappParticipantIdentityDriftError';
    this.axis = axis;
    this.expected = expected;
    this.actual = actual;
  }
}
