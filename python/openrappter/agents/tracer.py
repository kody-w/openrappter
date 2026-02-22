"""
AgentTracer - Observability and distributed tracing for the agent framework.

Provides span-based tracing across agent executions, chains, and sub-agent calls.
Each agent invocation creates a TraceSpan. Spans link to parents via TraceContext
propagation, forming a complete trace tree across multi-agent pipelines.

Mirrors TypeScript agents/tracer.ts
"""

import uuid
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Optional


@dataclass
class TraceSpan:
    """A single span in a trace."""
    id: str
    parent_id: Optional[str]
    trace_id: str
    agent_name: str
    operation: str
    start_time: str
    end_time: Optional[str] = None
    duration_ms: Optional[int] = None
    status: str = 'running'  # 'running', 'success', 'error'
    inputs: Optional[dict] = None
    outputs: Optional[dict] = None
    data_slush: Optional[dict] = None
    error: Optional[str] = None
    tags: Optional[dict] = None


@dataclass
class TraceContext:
    """Propagated context for linking parent-child spans."""
    trace_id: str
    span_id: str
    baggage: Optional[dict] = None


class AgentTracer:
    """Span-based tracing for agent execution."""

    def __init__(self, options=None):
        options = options or {}
        self._max_spans = options.get('max_spans', 1000)
        self._record_io = options.get('record_io', True)
        self._on_span_complete = options.get('on_span_complete')
        self._active_spans = {}  # span_id -> TraceSpan
        self._completed_spans = []  # list of TraceSpan

    def start_span(self, agent_name, operation, parent_context=None, inputs=None):
        """Create and start a new span.

        Returns (span, context) tuple.
        """
        span_id = self._generate_id()
        trace_id = parent_context.trace_id if parent_context else self._generate_id()
        parent_id = parent_context.span_id if parent_context else None

        span = TraceSpan(
            id=span_id,
            parent_id=parent_id,
            trace_id=trace_id,
            agent_name=agent_name,
            operation=operation,
            start_time=datetime.now(timezone.utc).isoformat(),
            status='running',
        )

        if self._record_io and inputs is not None:
            span.inputs = self._sanitize_io(inputs)

        if parent_context and parent_context.baggage:
            span.tags = dict(parent_context.baggage)

        self._active_spans[span_id] = span

        context = TraceContext(
            trace_id=trace_id,
            span_id=span_id,
            baggage=parent_context.baggage if parent_context else None,
        )

        return span, context

    def end_span(self, span_id, result=None):
        """Complete a span. Returns the completed span or None if not found."""
        span = self._active_spans.get(span_id)
        if not span:
            return None

        end_time = datetime.now(timezone.utc)
        start_ms = datetime.fromisoformat(span.start_time).timestamp() * 1000

        span.end_time = end_time.isoformat()
        span.duration_ms = int(end_time.timestamp() * 1000 - start_ms)
        span.status = (result or {}).get('status', 'success')

        if result:
            if 'error' in result:
                span.error = result['error']
            if self._record_io and 'outputs' in result:
                span.outputs = self._sanitize_io(result['outputs'])
            if 'data_slush' in result:
                span.data_slush = result['data_slush']

        del self._active_spans[span_id]
        self._add_completed(span)

        if self._on_span_complete:
            self._on_span_complete(span)

        return span

    def get_span(self, span_id):
        """Retrieve a span by ID, searching both active and completed spans."""
        if span_id in self._active_spans:
            return self._active_spans[span_id]
        for span in self._completed_spans:
            if span.id == span_id:
                return span
        return None

    def get_trace(self, trace_id):
        """Get all spans belonging to a trace, in chronological order."""
        active = [s for s in self._active_spans.values() if s.trace_id == trace_id]
        completed = [s for s in self._completed_spans if s.trace_id == trace_id]
        all_spans = active + completed
        all_spans.sort(key=lambda s: s.start_time)
        return all_spans

    def get_active_spans(self):
        """Get all spans currently in the 'running' state."""
        return list(self._active_spans.values())

    def get_completed_spans(self, limit=None):
        """Get recently completed spans, newest first."""
        reversed_spans = list(reversed(self._completed_spans))
        if limit is not None:
            return reversed_spans[:limit]
        return reversed_spans

    def clear(self):
        """Clear all spans (active and completed)."""
        self._active_spans.clear()
        self._completed_spans = []

    def to_json(self):
        """Return a serializable summary of current tracer state."""
        completed_by_trace = {}
        for span in self._completed_spans:
            completed_by_trace.setdefault(span.trace_id, []).append(span)

        traces = []
        for trace_id, spans in completed_by_trace.items():
            sorted_spans = sorted(spans, key=lambda s: s.start_time)
            root = next((s for s in sorted_spans if s.parent_id is None), sorted_spans[0] if sorted_spans else None)
            errors = [s for s in spans if s.status == 'error']
            total_ms = sum(s.duration_ms or 0 for s in spans)

            traces.append({
                'traceId': trace_id,
                'spanCount': len(spans),
                'status': 'error' if errors else 'success',
                'rootAgent': root.agent_name if root else None,
                'startTime': root.start_time if root else None,
                'totalDurationMs': total_ms,
                'errorCount': len(errors),
            })

        traces.sort(key=lambda t: t.get('startTime') or '', reverse=True)

        return {
            'activeSpans': [self._span_to_dict(s) for s in self._active_spans.values()],
            'completedSpans': [self._span_to_dict(s) for s in reversed(self._completed_spans)],
            'traceCount': len(completed_by_trace),
            'maxSpans': self._max_spans,
            'recordIO': self._record_io,
            'traces': traces,
        }

    def _generate_id(self):
        """Generate a 16-character ID."""
        return uuid.uuid4().hex[:16]

    def _sanitize_io(self, io_dict):
        """Sanitize an IO record for safe storage."""
        if not isinstance(io_dict, dict):
            return io_dict

        sanitized = {}
        for key, value in io_dict.items():
            if key in ('_context', '_slosh_filter', '_slosh_preferences'):
                continue
            if isinstance(value, str) and len(value) > 500:
                sanitized[key] = value[:500] + '...'
            elif value is not None and isinstance(value, dict):
                sanitized[key] = '[object]'
            else:
                sanitized[key] = value
        return sanitized

    def _add_completed(self, span):
        """Append a completed span and enforce the maxSpans retention limit."""
        self._completed_spans.append(span)
        if len(self._completed_spans) > self._max_spans:
            self._completed_spans = self._completed_spans[-self._max_spans:]

    def _span_to_dict(self, span):
        """Convert a TraceSpan to a plain dict for serialization."""
        d = {
            'id': span.id,
            'parentId': span.parent_id,
            'traceId': span.trace_id,
            'agentName': span.agent_name,
            'operation': span.operation,
            'startTime': span.start_time,
            'endTime': span.end_time,
            'durationMs': span.duration_ms,
            'status': span.status,
        }
        if span.inputs is not None:
            d['inputs'] = span.inputs
        if span.outputs is not None:
            d['outputs'] = span.outputs
        if span.data_slush is not None:
            d['dataSlush'] = span.data_slush
        if span.error is not None:
            d['error'] = span.error
        if span.tags is not None:
            d['tags'] = span.tags
        return d


def create_tracer(options=None):
    """Create a new AgentTracer with the given options."""
    return AgentTracer(options)


# Global tracer singleton
global_tracer = create_tracer()
