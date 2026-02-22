"""Tests for AgentTracer - span-based tracing for agent execution."""

import time
import pytest

from openrappter.agents.tracer import (
    AgentTracer,
    TraceSpan,
    TraceContext,
    create_tracer,
    global_tracer,
)


# ---------------------------------------------------------------------------
# Tests: constructor and factory
# ---------------------------------------------------------------------------

class TestTracerInit:
    def test_default_options(self):
        tracer = AgentTracer()
        assert tracer._max_spans == 1000
        assert tracer._record_io is True

    def test_custom_options(self):
        tracer = AgentTracer({'max_spans': 50, 'record_io': False})
        assert tracer._max_spans == 50
        assert tracer._record_io is False

    def test_factory_creates_instance(self):
        tracer = create_tracer()
        assert isinstance(tracer, AgentTracer)

    def test_global_tracer_is_instance(self):
        assert isinstance(global_tracer, AgentTracer)


# ---------------------------------------------------------------------------
# Tests: start/end span lifecycle
# ---------------------------------------------------------------------------

class TestSpanLifecycle:
    def test_start_span_returns_span_and_context(self):
        tracer = AgentTracer()
        span, context = tracer.start_span("TestAgent", "execute")
        assert isinstance(span, TraceSpan)
        assert isinstance(context, TraceContext)

    def test_span_starts_as_running(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("TestAgent", "execute")
        assert span.status == "running"

    def test_span_has_id_and_trace_id(self):
        tracer = AgentTracer()
        span, context = tracer.start_span("TestAgent", "execute")
        assert len(span.id) == 16
        assert len(context.trace_id) == 16

    def test_root_span_has_no_parent(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("TestAgent", "execute")
        assert span.parent_id is None

    def test_end_span_completes(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("TestAgent", "execute")
        completed = tracer.end_span(span.id, {"status": "success"})
        assert completed is not None
        assert completed.status == "success"
        assert completed.end_time is not None

    def test_end_span_calculates_duration(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("TestAgent", "execute")
        time.sleep(0.01)  # small delay
        completed = tracer.end_span(span.id, {"status": "success"})
        assert completed.duration_ms is not None
        assert completed.duration_ms >= 0

    def test_end_span_returns_none_for_unknown_id(self):
        tracer = AgentTracer()
        result = tracer.end_span("nonexistent")
        assert result is None


# ---------------------------------------------------------------------------
# Tests: parent-child span linking
# ---------------------------------------------------------------------------

class TestParentChildSpans:
    def test_child_span_links_to_parent(self):
        tracer = AgentTracer()
        _, parent_ctx = tracer.start_span("ParentAgent", "execute")
        child_span, child_ctx = tracer.start_span("ChildAgent", "execute", parent_ctx)
        assert child_span.parent_id == parent_ctx.span_id
        assert child_span.trace_id == parent_ctx.trace_id

    def test_child_shares_trace_id(self):
        tracer = AgentTracer()
        _, parent_ctx = tracer.start_span("ParentAgent", "execute")
        _, child_ctx = tracer.start_span("ChildAgent", "execute", parent_ctx)
        assert child_ctx.trace_id == parent_ctx.trace_id


# ---------------------------------------------------------------------------
# Tests: trace grouping
# ---------------------------------------------------------------------------

class TestTraceGrouping:
    def test_get_trace_returns_all_spans_in_trace(self):
        tracer = AgentTracer()
        span1, ctx1 = tracer.start_span("Agent1", "execute")
        span2, ctx2 = tracer.start_span("Agent2", "execute", ctx1)
        tracer.end_span(span1.id, {"status": "success"})
        tracer.end_span(span2.id, {"status": "success"})

        trace = tracer.get_trace(ctx1.trace_id)
        assert len(trace) == 2

    def test_get_trace_sorted_by_start_time(self):
        tracer = AgentTracer()
        span1, ctx1 = tracer.start_span("Agent1", "execute")
        span2, ctx2 = tracer.start_span("Agent2", "execute", ctx1)
        tracer.end_span(span1.id, {"status": "success"})
        tracer.end_span(span2.id, {"status": "success"})

        trace = tracer.get_trace(ctx1.trace_id)
        assert trace[0].start_time <= trace[1].start_time

    def test_separate_traces_not_mixed(self):
        tracer = AgentTracer()
        span1, ctx1 = tracer.start_span("Agent1", "execute")
        span2, ctx2 = tracer.start_span("Agent2", "execute")  # separate trace
        tracer.end_span(span1.id, {"status": "success"})
        tracer.end_span(span2.id, {"status": "success"})

        trace1 = tracer.get_trace(ctx1.trace_id)
        trace2 = tracer.get_trace(ctx2.trace_id)
        assert len(trace1) == 1
        assert len(trace2) == 1
        assert ctx1.trace_id != ctx2.trace_id


# ---------------------------------------------------------------------------
# Tests: active vs completed span tracking
# ---------------------------------------------------------------------------

class TestActiveCompleted:
    def test_active_spans_tracks_running(self):
        tracer = AgentTracer()
        tracer.start_span("Agent1", "execute")
        tracer.start_span("Agent2", "execute")
        assert len(tracer.get_active_spans()) == 2

    def test_end_span_moves_to_completed(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent1", "execute")
        tracer.end_span(span.id, {"status": "success"})
        assert len(tracer.get_active_spans()) == 0
        assert len(tracer.get_completed_spans()) == 1

    def test_completed_spans_newest_first(self):
        tracer = AgentTracer()
        span1, _ = tracer.start_span("Agent1", "execute")
        tracer.end_span(span1.id, {"status": "success"})
        span2, _ = tracer.start_span("Agent2", "execute")
        tracer.end_span(span2.id, {"status": "success"})

        completed = tracer.get_completed_spans()
        assert completed[0].agent_name == "Agent2"
        assert completed[1].agent_name == "Agent1"

    def test_completed_spans_limit(self):
        tracer = AgentTracer()
        for i in range(5):
            span, _ = tracer.start_span(f"Agent{i}", "execute")
            tracer.end_span(span.id, {"status": "success"})

        assert len(tracer.get_completed_spans(limit=3)) == 3


# ---------------------------------------------------------------------------
# Tests: max_spans eviction
# ---------------------------------------------------------------------------

class TestMaxSpansEviction:
    def test_evicts_oldest_when_over_limit(self):
        tracer = AgentTracer({'max_spans': 3})
        span_ids = []
        for i in range(5):
            span, _ = tracer.start_span(f"Agent{i}", "execute")
            tracer.end_span(span.id, {"status": "success"})
            span_ids.append(span.id)

        completed = tracer.get_completed_spans()
        assert len(completed) == 3
        completed_ids = [s.id for s in completed]
        # Oldest two should be evicted
        assert span_ids[0] not in completed_ids
        assert span_ids[1] not in completed_ids


# ---------------------------------------------------------------------------
# Tests: record_io
# ---------------------------------------------------------------------------

class TestRecordIO:
    def test_records_inputs_when_enabled(self):
        tracer = AgentTracer({'record_io': True})
        span, _ = tracer.start_span("Agent", "execute", inputs={"query": "hello"})
        assert span.inputs is not None
        assert span.inputs["query"] == "hello"

    def test_records_outputs_when_enabled(self):
        tracer = AgentTracer({'record_io': True})
        span, _ = tracer.start_span("Agent", "execute")
        completed = tracer.end_span(span.id, {"status": "success", "outputs": {"count": 42}})
        assert completed.outputs is not None
        assert completed.outputs["count"] == 42

    def test_no_inputs_when_disabled(self):
        tracer = AgentTracer({'record_io': False})
        span, _ = tracer.start_span("Agent", "execute", inputs={"query": "hello"})
        assert span.inputs is None

    def test_no_outputs_when_disabled(self):
        tracer = AgentTracer({'record_io': False})
        span, _ = tracer.start_span("Agent", "execute")
        completed = tracer.end_span(span.id, {"status": "success", "outputs": {"count": 42}})
        assert completed.outputs is None


# ---------------------------------------------------------------------------
# Tests: on_span_complete callback
# ---------------------------------------------------------------------------

class TestOnSpanComplete:
    def test_callback_fires_on_end_span(self):
        completed_spans = []
        tracer = AgentTracer({'on_span_complete': lambda s: completed_spans.append(s)})
        span, _ = tracer.start_span("Agent", "execute")
        tracer.end_span(span.id, {"status": "success"})
        assert len(completed_spans) == 1
        assert completed_spans[0].agent_name == "Agent"


# ---------------------------------------------------------------------------
# Tests: error tracking
# ---------------------------------------------------------------------------

class TestErrorTracking:
    def test_error_span_records_error_message(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent", "execute")
        completed = tracer.end_span(span.id, {"status": "error", "error": "something broke"})
        assert completed.status == "error"
        assert completed.error == "something broke"


# ---------------------------------------------------------------------------
# Tests: get_span
# ---------------------------------------------------------------------------

class TestGetSpan:
    def test_get_active_span(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent", "execute")
        found = tracer.get_span(span.id)
        assert found is not None
        assert found.id == span.id

    def test_get_completed_span(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent", "execute")
        tracer.end_span(span.id, {"status": "success"})
        found = tracer.get_span(span.id)
        assert found is not None
        assert found.status == "success"

    def test_get_nonexistent_span(self):
        tracer = AgentTracer()
        assert tracer.get_span("nope") is None


# ---------------------------------------------------------------------------
# Tests: to_json serialization
# ---------------------------------------------------------------------------

class TestToJSON:
    def test_to_json_returns_dict(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent", "execute")
        tracer.end_span(span.id, {"status": "success"})
        data = tracer.to_json()
        assert "activeSpans" in data
        assert "completedSpans" in data
        assert "traceCount" in data
        assert "traces" in data

    def test_to_json_trace_summary(self):
        tracer = AgentTracer()
        span1, ctx = tracer.start_span("Root", "execute")
        span2, _ = tracer.start_span("Child", "execute", ctx)
        tracer.end_span(span1.id, {"status": "success"})
        tracer.end_span(span2.id, {"status": "success"})
        data = tracer.to_json()
        assert data["traceCount"] == 1
        assert data["traces"][0]["spanCount"] == 2
        assert data["traces"][0]["rootAgent"] == "Root"


# ---------------------------------------------------------------------------
# Tests: clear
# ---------------------------------------------------------------------------

class TestClear:
    def test_clear_removes_all_spans(self):
        tracer = AgentTracer()
        span, _ = tracer.start_span("Agent", "execute")
        tracer.end_span(span.id, {"status": "success"})
        tracer.start_span("Agent2", "execute")
        tracer.clear()
        assert len(tracer.get_active_spans()) == 0
        assert len(tracer.get_completed_spans()) == 0


# ---------------------------------------------------------------------------
# Tests: baggage propagation
# ---------------------------------------------------------------------------

class TestBaggage:
    def test_baggage_propagated_to_child_tags(self):
        tracer = AgentTracer()
        parent_ctx = TraceContext(trace_id="trace1", span_id="span1", baggage={"env": "test"})
        child_span, _ = tracer.start_span("Child", "execute", parent_ctx)
        assert child_span.tags is not None
        assert child_span.tags["env"] == "test"
