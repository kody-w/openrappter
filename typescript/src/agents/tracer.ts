/**
 * AgentTracer — Observability and distributed tracing for the agent framework.
 *
 * Provides OpenTelemetry-inspired span-based tracing across agent executions,
 * chains, and sub-agent calls. Each agent invocation (execute, perform, slosh)
 * creates a TraceSpan. Spans link to parents via TraceContext propagation,
 * forming a complete trace tree across multi-agent pipelines.
 *
 * Usage:
 *   const { span, context } = tracer.startSpan('ShellAgent', 'execute', undefined, { action: 'bash' });
 *   // ... run agent ...
 *   tracer.endSpan(span.id, { status: 'success', outputs: { exitCode: 0 } });
 *
 *   const trace = tracer.getTrace(context.traceId);
 *   // trace is an array of all spans in chronological order
 */

import { randomUUID } from 'crypto';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface TraceSpan {
  /** Unique span ID */
  id: string;
  /** Parent span ID (null for root) */
  parentId: string | null;
  /** Trace ID (shared across the whole trace tree) */
  traceId: string;
  /** Agent name */
  agentName: string;
  /** Span operation name (e.g., 'execute', 'perform', 'slosh') */
  operation: string;
  /** ISO 8601 start time */
  startTime: string;
  /** ISO 8601 end time (null if still running) */
  endTime: string | null;
  /** Duration in ms (null if still running) */
  durationMs: number | null;
  /** Status */
  status: 'running' | 'success' | 'error';
  /** Input kwargs (sanitized) */
  inputs?: Record<string, unknown>;
  /** Output result summary */
  outputs?: Record<string, unknown>;
  /** Data slush flow */
  dataSlush?: {
    upstream: Record<string, unknown> | null;
    downstream: Record<string, unknown> | null;
  };
  /** Error message if status is 'error' */
  error?: string;
  /** Arbitrary tags */
  tags?: Record<string, string>;
}

export interface TraceContext {
  /** Trace ID */
  traceId: string;
  /** Current span ID (becomes parentId for child spans) */
  spanId: string;
  /** Baggage items (propagated key-value pairs) */
  baggage?: Record<string, string>;
}

export interface AgentTracerOptions {
  /** Max completed spans to retain (default: 1000) */
  maxSpans?: number;
  /** Whether to record inputs/outputs (default: true) */
  recordIO?: boolean;
  /** Custom span handler called when a span completes */
  onSpanComplete?: (span: TraceSpan) => void;
}

// ── AgentTracer ───────────────────────────────────────────────────────────────

export class AgentTracer {
  private readonly maxSpans: number;
  private readonly recordIO: boolean;
  private readonly onSpanComplete: ((span: TraceSpan) => void) | undefined;

  /** Active (running) spans keyed by span ID */
  private activeSpans: Map<string, TraceSpan> = new Map();

  /** Completed spans in insertion order */
  private completedSpans: TraceSpan[] = [];

  constructor(options: AgentTracerOptions = {}) {
    this.maxSpans = options.maxSpans ?? 1000;
    this.recordIO = options.recordIO ?? true;
    this.onSpanComplete = options.onSpanComplete;
  }

  // ── Span Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Create and start a new span.
   *
   * If parentContext is provided the new span is a child of that context's
   * current span and shares the same traceId. Otherwise a new root span
   * (and therefore a new trace) is created.
   *
   * Returns both the span and a TraceContext that callers should propagate
   * to child operations so they can link back via parentId.
   */
  startSpan(
    agentName: string,
    operation: string,
    parentContext?: TraceContext,
    inputs?: Record<string, unknown>,
  ): { span: TraceSpan; context: TraceContext } {
    const id = this.generateId();
    const traceId = parentContext?.traceId ?? this.generateId();
    const parentId = parentContext?.spanId ?? null;

    const span: TraceSpan = {
      id,
      parentId,
      traceId,
      agentName,
      operation,
      startTime: new Date().toISOString(),
      endTime: null,
      durationMs: null,
      status: 'running',
    };

    if (this.recordIO && inputs !== undefined) {
      span.inputs = this.sanitizeIO(inputs);
    }

    if (parentContext?.baggage) {
      span.tags = { ...parentContext.baggage };
    }

    this.activeSpans.set(id, span);

    const context: TraceContext = {
      traceId,
      spanId: id,
      baggage: parentContext?.baggage,
    };

    return { span, context };
  }

  /**
   * Complete a span. Computes duration and transitions status to success or error.
   *
   * Returns the completed span or null if the span ID was not found.
   */
  endSpan(
    spanId: string,
    result?: {
      status: 'success' | 'error';
      outputs?: Record<string, unknown>;
      error?: string;
      dataSlush?: TraceSpan['dataSlush'];
    },
  ): TraceSpan | null {
    const span = this.activeSpans.get(spanId);
    if (!span) return null;

    const endTime = new Date();
    const startMs = new Date(span.startTime).getTime();

    span.endTime = endTime.toISOString();
    span.durationMs = endTime.getTime() - startMs;
    span.status = result?.status ?? 'success';

    if (result?.error !== undefined) {
      span.error = result.error;
    }

    if (this.recordIO && result?.outputs !== undefined) {
      span.outputs = this.sanitizeIO(result.outputs);
    }

    if (result?.dataSlush !== undefined) {
      span.dataSlush = result.dataSlush;
    }

    this.activeSpans.delete(spanId);
    this.addCompleted(span);

    if (this.onSpanComplete) {
      this.onSpanComplete(span);
    }

    return span;
  }

  // ── Querying ────────────────────────────────────────────────────────────────

  /**
   * Retrieve a span by ID, searching both active and completed spans.
   */
  getSpan(spanId: string): TraceSpan | null {
    return this.activeSpans.get(spanId) ?? this.completedSpans.find(s => s.id === spanId) ?? null;
  }

  /**
   * Get all spans (active and completed) belonging to a trace, in chronological order.
   */
  getTrace(traceId: string): TraceSpan[] {
    const active = Array.from(this.activeSpans.values()).filter(s => s.traceId === traceId);
    const completed = this.completedSpans.filter(s => s.traceId === traceId);

    return [...active, ...completed].sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  /**
   * Get all spans currently in the 'running' state.
   */
  getActiveSpans(): TraceSpan[] {
    return Array.from(this.activeSpans.values());
  }

  /**
   * Get recently completed spans, newest first.
   *
   * @param limit - Maximum number of spans to return. Defaults to all retained spans.
   */
  getCompletedSpans(limit?: number): TraceSpan[] {
    const reversed = [...this.completedSpans].reverse();
    return limit !== undefined ? reversed.slice(0, limit) : reversed;
  }

  // ── Utility ─────────────────────────────────────────────────────────────────

  /**
   * Clear all spans (active and completed). Useful between test runs.
   */
  clear(): void {
    this.activeSpans.clear();
    this.completedSpans = [];
  }

  /**
   * Return a serializable summary of current tracer state, suitable for
   * dashboards or JSON export.
   */
  toJSON(): object {
    const completedByTrace = new Map<string, TraceSpan[]>();
    for (const span of this.completedSpans) {
      const group = completedByTrace.get(span.traceId) ?? [];
      group.push(span);
      completedByTrace.set(span.traceId, group);
    }

    const traces = Array.from(completedByTrace.entries()).map(([traceId, spans]) => {
      const sorted = [...spans].sort((a, b) => a.startTime.localeCompare(b.startTime));
      const root = sorted.find(s => s.parentId === null) ?? sorted[0];
      const errors = spans.filter(s => s.status === 'error');
      const durations = spans.map(s => s.durationMs ?? 0);
      const totalMs = durations.reduce((acc, d) => acc + d, 0);

      return {
        traceId,
        spanCount: spans.length,
        status: errors.length > 0 ? 'error' : 'success',
        rootAgent: root?.agentName ?? null,
        startTime: root?.startTime ?? null,
        totalDurationMs: totalMs,
        errorCount: errors.length,
      };
    });

    return {
      activeSpans: Array.from(this.activeSpans.values()),
      completedSpans: [...this.completedSpans].reverse(),
      traceCount: completedByTrace.size,
      maxSpans: this.maxSpans,
      recordIO: this.recordIO,
      traces: traces.sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? '')),
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Generate a 16-character ID by truncating a UUID (removing dashes).
   */
  private generateId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 16);
  }

  /**
   * Sanitize an IO record for safe storage: remove private/context keys and
   * truncate large string values so spans stay lightweight.
   */
  private sanitizeIO(io: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(io)) {
      // Skip internal agent context injected by execute()
      if (key === '_context' || key === '_sloshFilter' || key === '_sloshPreferences') {
        continue;
      }

      if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.slice(0, 500) + '…';
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // Shallow clone nested objects without recursing into large trees
        sanitized[key] = '[object]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Append a completed span and enforce the maxSpans retention limit.
   * Oldest spans are evicted first (FIFO).
   */
  private addCompleted(span: TraceSpan): void {
    this.completedSpans.push(span);
    if (this.completedSpans.length > this.maxSpans) {
      this.completedSpans.splice(0, this.completedSpans.length - this.maxSpans);
    }
  }
}

// ── Factory & Singleton ───────────────────────────────────────────────────────

/**
 * Create a new AgentTracer with the given options.
 */
export function createTracer(options?: AgentTracerOptions): AgentTracer {
  return new AgentTracer(options);
}

/**
 * Global tracer singleton. Ready to use with zero configuration.
 * Override by replacing with a custom instance from `createTracer()`.
 */
export const globalTracer: AgentTracer = createTracer();
