/**
 * Gateway observability: bounded in-memory counters and centralized
 * structured logging for the WebSocket/HTTP gateway.
 *
 * Design goals:
 *  - Low-cardinality, credential-free metrics snapshot suitable for
 *    exposing via `/status`, `/health`, and the canonical `status`/`health`
 *    RPC methods without breaking their existing fields.
 *  - Counters live for exactly one `GatewayServer` instance and reset
 *    predictably: a new instance starts at zero, and `reset()` re-arms an
 *    existing instance (used by tests and instance recycling). They are
 *    never persisted to disk.
 *  - Structured JSON logging is strictly opt-in via
 *    `OPENRAPPTER_LOG_FORMAT=json` so default output stays human-readable
 *    and free of per-request noise.
 *  - Never log method names, user input, tokens, passwords, or stack
 *    traces — only bounded, low-cardinality fields (counts, durations,
 *    enums).
 */

/** Mutually-exclusive classification of a single RPC dispatch attempt. */
export type RpcOutcome = 'success' | 'error' | 'auth_failure' | 'rate_limited' | 'timeout';

export interface GatewayMetricsSnapshot {
  rpcRequestsTotal: number;
  rpcSuccessTotal: number;
  rpcErrorsTotal: number;
  rpcAuthFailuresTotal: number;
  rpcRateLimitedTotal: number;
  rpcTimeoutsTotal: number;
  activeConnections: number;
  activeAgentExecutions: number;
  uptimeSeconds: number;
}

/** Thrown internally to classify a dispatch outcome as `timeout` rather than a generic `error`. */
export class GatewayTimeoutError extends Error {
  constructor(message = 'Method execution timed out') {
    super(message);
    this.name = 'GatewayTimeoutError';
  }
}

/**
 * Bounded in-memory counters for one gateway server instance.
 *
 * Every counter is a plain number (no unbounded maps/labels), so memory
 * use never grows with request volume. `/health` and `/status` polling
 * never touches this class — only the RPC dispatch paths (HTTP JSON-RPC
 * POST and WS `dispatchMethod`) call `recordRequest()`.
 */
export class GatewayMetrics {
  private rpcRequestsTotal = 0;
  private rpcSuccessTotal = 0;
  private rpcErrorsTotal = 0;
  private rpcAuthFailuresTotal = 0;
  private rpcRateLimitedTotal = 0;
  private rpcTimeoutsTotal = 0;
  private activeAgentExecutions = 0;
  private startedAt: number | null = null;

  /**
   * Mark the metrics window as started. Resets every counter/gauge to zero
   * first — this is the predictable "reset per server instance/start"
   * boundary so restarting the same `GatewayServer` instance behaves
   * identically to a fresh one.
   */
  start(): void {
    this.reset();
    this.startedAt = Date.now();
  }

  /** Mark the metrics window as stopped (uptime reports 0 until the next start). */
  stop(): void {
    this.startedAt = null;
  }

  /**
   * Reset all counters and gauges to zero. This is the predictable reset
   * boundary for tests/instance recycling — a fresh `GatewayServer`
   * (and thus a fresh `GatewayMetrics`) always starts here implicitly.
   */
  reset(): void {
    this.rpcRequestsTotal = 0;
    this.rpcSuccessTotal = 0;
    this.rpcErrorsTotal = 0;
    this.rpcAuthFailuresTotal = 0;
    this.rpcRateLimitedTotal = 0;
    this.rpcTimeoutsTotal = 0;
    this.activeAgentExecutions = 0;
    this.startedAt = null;
  }

  /**
   * Record exactly one RPC dispatch outcome. Call once per request on the
   * HTTP JSON-RPC and WS dispatch paths — never for `/health` or `/status`
   * polling, and never more than once per request.
   */
  recordRequest(outcome: RpcOutcome): void {
    this.rpcRequestsTotal++;
    switch (outcome) {
      case 'success':
        this.rpcSuccessTotal++;
        break;
      case 'error':
        this.rpcErrorsTotal++;
        break;
      case 'auth_failure':
        this.rpcAuthFailuresTotal++;
        break;
      case 'rate_limited':
        this.rpcRateLimitedTotal++;
        break;
      case 'timeout':
        this.rpcTimeoutsTotal++;
        break;
    }
  }

  /** Gauge: an agent execution began (chat.send background run, `agent` RPC, or cron trigger). */
  agentExecutionStarted(): void {
    this.activeAgentExecutions++;
  }

  /** Gauge: an agent execution finished (success or failure). Never goes negative. */
  agentExecutionFinished(): void {
    if (this.activeAgentExecutions > 0) this.activeAgentExecutions--;
  }

  /** Bounded, low-cardinality snapshot — safe to serialize into `/status` and `/health`. */
  snapshot(activeConnections: number): GatewayMetricsSnapshot {
    return {
      rpcRequestsTotal: this.rpcRequestsTotal,
      rpcSuccessTotal: this.rpcSuccessTotal,
      rpcErrorsTotal: this.rpcErrorsTotal,
      rpcAuthFailuresTotal: this.rpcAuthFailuresTotal,
      rpcRateLimitedTotal: this.rpcRateLimitedTotal,
      rpcTimeoutsTotal: this.rpcTimeoutsTotal,
      activeConnections,
      activeAgentExecutions: this.activeAgentExecutions,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
    };
  }
}

// ── Structured logging ──────────────────────────────────────────────────

export type GatewayLogLevel = 'info' | 'warn' | 'error';
export type GatewayLogFields = Record<string, string | number | boolean | undefined>;

/** Keys that must never appear verbatim in a structured log line. */
const SECRET_KEY_PATTERN = /token|password|secret|credential|authorization/i;

function isJsonLogFormat(): boolean {
  return (process.env.OPENRAPPTER_LOG_FORMAT || '').trim().toLowerCase() === 'json';
}

/**
 * Strip anything that looks like a secret from a fields object. Defense in
 * depth: callers must only ever pass safe numeric/enum fields, but this
 * guarantees a mislabeled field can't leak a credential into logs.
 */
function redactFields(fields?: GatewayLogFields): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!fields) return safe;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    safe[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return safe;
}

function emit(level: GatewayLogLevel, humanMessage: string, jsonPayload: Record<string, unknown>): void {
  const line = isJsonLogFormat() ? JSON.stringify(jsonPayload) : humanMessage;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Log a gateway lifecycle event (start/stop/listener error). Always
 * emitted — as a plain human message by default, or as a structured
 * `{ timestamp, level, component, event, ...fields }` JSON record when
 * `OPENRAPPTER_LOG_FORMAT=json` is set.
 */
export function logGatewayLifecycle(
  component: string,
  event: string,
  message: string,
  fields?: GatewayLogFields,
  level: GatewayLogLevel = 'info'
): void {
  emit(level, message, {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...redactFields(fields),
  });
}

/**
 * Log a per-request gateway event. Only emitted when
 * `OPENRAPPTER_LOG_FORMAT=json` is set, keeping default operation free of
 * per-request console noise. `fields` must only ever contain bounded,
 * low-cardinality values (outcome enums, durations, counts) — never
 * method names, user input, tokens, or stack traces.
 */
export function logGatewayRequest(
  component: string,
  event: string,
  fields?: GatewayLogFields,
  level: GatewayLogLevel = 'info'
): void {
  if (!isJsonLogFormat()) return;
  emit(level, '', {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...redactFields(fields),
  });
}
