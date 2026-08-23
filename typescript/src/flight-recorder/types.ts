/**
 * Flight Recorder v1 — provider-neutral durable event contract.
 *
 * The envelope is intentionally smaller than an OpenTelemetry span and more
 * privacy-aware than a chat transcript. It records enough to explain and
 * replay a run without persisting raw prompts, responses, tool arguments, or
 * file contents unless an operator explicitly opts in.
 */

export const FLIGHT_EVENT_SCHEMA = "openrappter-event/1.0" as const;

export type FlightEventStatus =
  | "started"
  | "success"
  | "error"
  | "decision"
  | "info";

export type FlightEventKind =
  | "trace.started"
  | "trace.completed"
  | "trace.failed"
  | "context.assembled"
  | "provider.attempt.started"
  | "provider.attempt.completed"
  | "provider.attempt.failed"
  | "provider.selected"
  | "agent.execute.started"
  | "agent.execute.completed"
  | "agent.execute.failed"
  | "tool.call.started"
  | "tool.call.completed"
  | "tool.call.failed"
  | "recorder.error"
  | (string & {});

export interface FlightEventInput {
  kind: FlightEventKind;
  source: string;
  status?: FlightEventStatus;
  traceId?: string;
  parentId?: string | null;
  sessionId?: string;
  workspaceId?: string;
  providerId?: string;
  model?: string;
  agentName?: string;
  toolName?: string;
  timestamp?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  /**
   * Potentially sensitive IO. The recorder drops this field by default and
   * sanitizes it recursively only when recordIO is explicitly enabled.
   */
  payload?: unknown;
}

export interface FlightEvent extends Omit<FlightEventInput, "timestamp"> {
  schema: typeof FLIGHT_EVENT_SCHEMA;
  id: string;
  sequence: number;
  traceId: string;
  parentId: string | null;
  timestamp: string;
  status: FlightEventStatus;
  metadata: Record<string, unknown>;
  payload?: unknown;
  /** SHA-256 of the canonical persisted event body (excluding this field). */
  contentHash: string;
}

export interface FlightEventQuery {
  traceId?: string;
  sessionId?: string;
  workspaceId?: string;
  kind?: FlightEventKind | FlightEventKind[];
  source?: string;
  providerId?: string;
  agentName?: string;
  toolName?: string;
  status?: FlightEventStatus;
  since?: string;
  until?: string;
  /** Trace queries default to sequence order; cross-trace queries use time. */
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface FlightRecorderPrivacy {
  /** Persist payload IO. False by default. */
  recordIO?: boolean;
  /** Maximum serialized payload bytes after redaction. Default 16 KiB. */
  maxPayloadBytes?: number;
  /** Additional case-insensitive key names to redact recursively. */
  redactedKeys?: string[];
  /** Additional exact secret values to redact wherever they occur. */
  redactedValues?: string[];
  /** Additional path patterns to exclude entirely. */
  excludedPathPatterns?: RegExp[];
}

export interface FlightRecorderOptions {
  enabled?: boolean;
  databasePath?: string;
  inMemory?: boolean;
  privacy?: FlightRecorderPrivacy;
  /** Maximum retained events. Oldest are pruned after append. Default 10,000. */
  retentionEvents?: number;
  /** 32-byte hex HMAC key for opaque session identities. */
  identityKey?: string;
}

export interface FlightRecorderHealth {
  enabled: boolean;
  initialized: boolean;
  eventCount: number;
  errorCount: number;
  lastError?: string;
  databasePath?: string;
  pendingOwnershipReleases: number;
}

export interface FlightTraceContext {
  traceId: string;
  sessionId?: string;
  workspaceId?: string;
  parentId?: string | null;
}

export interface FlightExport {
  schema: "openrappter-flight-export/1.0";
  exportedAt: string;
  events: FlightEvent[];
}

export interface FlightAppendReceipt {
  eventId: string;
  traceId: string;
  kind: string;
  sequence: number;
  contentHash: string;
}

export interface FlightLedger {
  initialize(): Promise<void>;
  close(): Promise<void>;
  append(event: FlightEvent): Promise<FlightAppendReceipt | void>;
  query(query?: FlightEventQuery): Promise<FlightEvent[]>;
  count(): Promise<number>;
  prune(keep: number): Promise<number>;
  export(query?: FlightEventQuery): Promise<FlightExport>;
  import(data: FlightExport, options?: { replace?: boolean }): Promise<number>;
  clear(): Promise<void>;
  lastSequence?(traceId: string): Promise<number>;
  pruneRuntime?(keep: number): Promise<number>;
  bindIdentityKey?(identityKey: string): Promise<void>;
  releaseEventOwnership?(eventId: string): Promise<void>;
  queueEventOwnershipRelease?(
    eventId: string,
    maxPending: number,
  ): Promise<number>;
  reconcileEventOwnershipReleases?(
    limit: number,
  ): Promise<{ released: number; pending: number }>;
  pendingOwnershipReleaseCount?(): Promise<number>;
}
