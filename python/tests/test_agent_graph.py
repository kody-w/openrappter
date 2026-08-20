"""Tests for AgentGraph - DAG executor for parallel agent pipelines."""

import json
import time
import threading
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.graph import AgentGraph, GraphNode, create_agent_graph


# ---------------------------------------------------------------------------
# Helper agents
# ---------------------------------------------------------------------------

class EchoAgent(BasicAgent):
    """Returns a success result with optional data_slush."""

    def __init__(self, name="Echo", slush_value=None):
        self.name = name
        self._slush_value = slush_value
        metadata = {
            "name": name,
            "description": f"Echo agent: {name}",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        payload = {"status": "success", "agent": self.name}
        if self._slush_value is not None:
            payload["data_slush"] = self._slush_value
        return json.dumps(payload)


class UpstreamCapture(BasicAgent):
    """Captures upstream_slush from context for assertions."""

    def __init__(self, name="Capture"):
        self.captured_upstream = None
        metadata = {
            "name": name,
            "description": "Captures upstream slush",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        self.captured_upstream = self.context.get("upstream_slush")
        upstream_keys = list(self.captured_upstream.keys()) if self.captured_upstream else []
        return json.dumps({
            "status": "success",
            "upstream_sources": upstream_keys,
            "data_slush": {"source_agent": self.name, "captured": True},
        })


class FailingAgent(BasicAgent):
    """Always raises an exception."""

    def __init__(self, name="Failing"):
        metadata = {
            "name": name,
            "description": "Always fails",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("intentional failure")


class SlowAgent(BasicAgent):
    """Sleeps for a configurable duration, records thread id."""

    def __init__(self, name="Slow", delay=0.1):
        self._delay = delay
        self.thread_id = None
        metadata = {
            "name": name,
            "description": f"Slow agent: {name}",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        self.thread_id = threading.current_thread().ident
        time.sleep(self._delay)
        return json.dumps({"status": "success", "agent": self.name, "data_slush": {"done": True}})


# ---------------------------------------------------------------------------
# Tests: constructor and factory
# ---------------------------------------------------------------------------

class TestGraphInit:
    def test_empty_graph_has_zero_length(self):
        graph = AgentGraph()
        assert graph.length == 0

    def test_factory_creates_instance(self):
        graph = create_agent_graph()
        assert isinstance(graph, AgentGraph)

    def test_factory_passes_options(self):
        graph = create_agent_graph({'stop_on_error': True})
        assert graph._stop_on_error is True


# ---------------------------------------------------------------------------
# Tests: add_node
# ---------------------------------------------------------------------------

class TestAddNode:
    def test_add_node_returns_self(self):
        graph = AgentGraph()
        result = graph.add_node(GraphNode(name="a", agent=EchoAgent()))
        assert result is graph

    def test_add_node_increments_length(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent()))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B")))
        assert graph.length == 2

    def test_duplicate_node_raises(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent()))
        with pytest.raises(ValueError, match="duplicate"):
            graph.add_node(GraphNode(name="a", agent=EchoAgent("B")))

    def test_get_node_names(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="x", agent=EchoAgent()))
        graph.add_node(GraphNode(name="y", agent=EchoAgent("Y")))
        assert graph.get_node_names() == ["x", "y"]


# ---------------------------------------------------------------------------
# Tests: validate
# ---------------------------------------------------------------------------

class TestValidate:
    def test_valid_linear_graph(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent()))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B"), depends_on=["a"]))
        result = graph.validate()
        assert result["valid"] is True
        assert result["errors"] == []

    def test_missing_dependency(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent(), depends_on=["missing"]))
        result = graph.validate()
        assert result["valid"] is False
        assert any("missing" in e for e in result["errors"])

    def test_cycle_detection(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent(), depends_on=["b"]))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B"), depends_on=["a"]))
        result = graph.validate()
        assert result["valid"] is False
        assert any("Cycle" in e for e in result["errors"])


# ---------------------------------------------------------------------------
# Tests: single node execution
# ---------------------------------------------------------------------------

class TestSingleNode:
    def test_single_node_success(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="only", agent=EchoAgent()))
        result = graph.run()
        assert result.status == "success"
        assert "only" in result.nodes
        assert result.nodes["only"].status == "success"

    def test_single_node_has_duration(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="only", agent=EchoAgent()))
        result = graph.run()
        assert result.nodes["only"].duration_ms >= 0


# ---------------------------------------------------------------------------
# Tests: linear dependency chain
# ---------------------------------------------------------------------------

class TestLinearChain:
    def test_linear_executes_in_order(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent("A")))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B"), depends_on=["a"]))
        graph.add_node(GraphNode(name="c", agent=EchoAgent("C"), depends_on=["b"]))
        result = graph.run()
        assert result.status == "success"
        order = result.execution_order
        assert order.index("a") < order.index("b") < order.index("c")


# ---------------------------------------------------------------------------
# Tests: parallel roots
# ---------------------------------------------------------------------------

class TestParallelRoots:
    def test_parallel_roots_all_execute(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent("A")))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B")))
        graph.add_node(GraphNode(name="c", agent=EchoAgent("C")))
        result = graph.run()
        assert result.status == "success"
        assert len(result.nodes) == 3


# ---------------------------------------------------------------------------
# Tests: diamond pattern (fan-out/fan-in)
# ---------------------------------------------------------------------------

class TestDiamondPattern:
    def test_diamond_executes_correctly(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="root", agent=EchoAgent("Root", slush_value={"root": True})))
        graph.add_node(GraphNode(name="left", agent=EchoAgent("Left", slush_value={"left": True}), depends_on=["root"]))
        graph.add_node(GraphNode(name="right", agent=EchoAgent("Right", slush_value={"right": True}), depends_on=["root"]))
        graph.add_node(GraphNode(name="sink", agent=UpstreamCapture("Sink"), depends_on=["left", "right"]))
        result = graph.run()
        assert result.status == "success"
        order = result.execution_order
        assert order.index("root") < order.index("left")
        assert order.index("root") < order.index("right")
        assert order.index("left") < order.index("sink")
        assert order.index("right") < order.index("sink")


# ---------------------------------------------------------------------------
# Tests: multi-upstream slush merging
# ---------------------------------------------------------------------------

class TestSlushMerging:
    def test_multi_upstream_slush_merged(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent("A", slush_value={"from_a": True})))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B", slush_value={"from_b": True})))
        sink = UpstreamCapture("Sink")
        graph.add_node(GraphNode(name="sink", agent=sink, depends_on=["a", "b"]))
        result = graph.run()
        assert sink.captured_upstream is not None
        assert "a" in sink.captured_upstream
        assert "b" in sink.captured_upstream


# ---------------------------------------------------------------------------
# Tests: error handling - skip dependents
# ---------------------------------------------------------------------------

class TestErrorSkipDependents:
    def test_failed_node_skips_dependents(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="fail", agent=FailingAgent()))
        graph.add_node(GraphNode(name="dep", agent=EchoAgent("Dep"), depends_on=["fail"]))
        result = graph.run()
        assert result.status == "partial"
        assert result.nodes["fail"].status == "error"
        assert result.nodes["dep"].status == "skipped"

    def test_transitive_dependents_skipped(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="fail", agent=FailingAgent()))
        graph.add_node(GraphNode(name="mid", agent=EchoAgent("Mid"), depends_on=["fail"]))
        graph.add_node(GraphNode(name="end", agent=EchoAgent("End"), depends_on=["mid"]))
        result = graph.run()
        assert result.nodes["mid"].status == "skipped"
        assert result.nodes["end"].status == "skipped"


# ---------------------------------------------------------------------------
# Tests: stopOnError
# ---------------------------------------------------------------------------

class TestStopOnError:
    def test_stop_on_error_stops_immediately(self):
        graph = AgentGraph({'stop_on_error': True})
        graph.add_node(GraphNode(name="fail", agent=FailingAgent()))
        graph.add_node(GraphNode(name="dep", agent=EchoAgent("Dep"), depends_on=["fail"]))
        result = graph.run()
        assert result.status == "error"
        assert result.error is not None


# ---------------------------------------------------------------------------
# Tests: run raises on invalid graph
# ---------------------------------------------------------------------------

class TestRunValidation:
    def test_run_raises_on_cycle(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent(), depends_on=["b"]))
        graph.add_node(GraphNode(name="b", agent=EchoAgent("B"), depends_on=["a"]))
        with pytest.raises(ValueError, match="validation failed"):
            graph.run()

    def test_run_raises_on_missing_dependency(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="a", agent=EchoAgent(), depends_on=["missing"]))
        with pytest.raises(ValueError, match="validation failed"):
            graph.run()


# ---------------------------------------------------------------------------
# Tests: parallel execution
# ---------------------------------------------------------------------------

class TestParallelExecution:
    def test_parallel_roots_execute_concurrently(self):
        """Three roots each sleeping 0.1s should finish in ~0.1s (not 0.3s)."""
        agents = [SlowAgent(f"S{i}", delay=0.1) for i in range(3)]
        graph = AgentGraph()
        for i, agent in enumerate(agents):
            graph.add_node(GraphNode(name=f"s{i}", agent=agent))

        start = time.time()
        result = graph.run()
        elapsed = time.time() - start

        assert result.status == "success"
        assert len(result.nodes) == 3
        # Parallel: should be well under 0.3s total (sequential would be ~0.3s)
        assert elapsed < 0.25, f"Took {elapsed:.2f}s — expected parallel (~0.1s)"

    def test_parallel_false_falls_back_to_sequential(self):
        """With parallel=False, three roots sleeping 0.1s should take ~0.3s."""
        agents = [SlowAgent(f"S{i}", delay=0.1) for i in range(3)]
        graph = AgentGraph({'parallel': False})
        for i, agent in enumerate(agents):
            graph.add_node(GraphNode(name=f"s{i}", agent=agent))

        start = time.time()
        result = graph.run()
        elapsed = time.time() - start

        assert result.status == "success"
        # Sequential: should be >= 0.3s
        assert elapsed >= 0.25, f"Took {elapsed:.2f}s — expected sequential (~0.3s)"

    def test_parallel_uses_different_threads(self):
        """Parallel roots should execute on different threads."""
        agents = [SlowAgent(f"S{i}", delay=0.05) for i in range(3)]
        graph = AgentGraph()
        for i, agent in enumerate(agents):
            graph.add_node(GraphNode(name=f"s{i}", agent=agent))

        graph.run()
        thread_ids = {a.thread_id for a in agents}
        # At least 2 different thread IDs (main thread won't be reused by executor)
        assert len(thread_ids) >= 2, f"Expected multiple threads, got {thread_ids}"


# ---------------------------------------------------------------------------
# Tests: node timeout
#
# node_timeout was accepted by the constructor and then never read, so Python
# silently ignored a bound TypeScript has always enforced: a hung node hung the
# whole graph forever. Measured before the fix -- a 100ms budget against a 3s
# node returned after 3.03s and reported status "success".
# ---------------------------------------------------------------------------

class TestNodeTimeout:
    def test_slow_node_times_out_and_fails(self):
        graph = create_agent_graph({"node_timeout": 100})
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=5.0))

        started = time.time()
        result = graph.run()
        elapsed = time.time() - started

        node = result.nodes["slow"]
        assert node.status == "error"
        assert "timeout" in node.result.get("message", "").lower()
        # Released at the timeout, not at the sleeping node's own pace. Without
        # this the test passes even when the timeout is ignored entirely.
        assert elapsed < 1.0, f"run() took {elapsed:.2f}s for a 100ms node_timeout"

    def test_timeout_message_matches_typescript(self):
        """TS raises `Node timeout after ${nodeTimeout}ms`; Python must match."""
        graph = create_agent_graph({"node_timeout": 100})
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=5.0))

        node = graph.run().nodes["slow"]
        assert node.result["message"] == "Node timeout after 100ms"

    def test_timed_out_node_skips_its_dependents(self):
        """A timed-out node fails like any other, so dependents are skipped."""
        graph = create_agent_graph({"node_timeout": 100})
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=5.0))
        graph.add_node(name="after", agent=EchoAgent("After"), depends_on=["slow"])

        result = graph.run()

        assert result.nodes["slow"].status == "error"
        assert result.nodes["after"].status == "skipped"
        assert result.status == "partial"

    def test_fast_node_is_unaffected_by_a_generous_timeout(self):
        """A node well inside its budget must not be failed or delayed."""
        graph = create_agent_graph({"node_timeout": 10000})
        graph.add_node(name="quick", agent=EchoAgent("Quick"))

        started = time.time()
        result = graph.run()
        elapsed = time.time() - started

        assert result.nodes["quick"].status == "success"
        assert result.status == "success"
        # The wait is bounded by the node, never by the timeout budget.
        assert elapsed < 1.0, f"a fast node took {elapsed:.2f}s under a 10s budget"

    def test_no_timeout_configured_lets_a_slow_node_finish(self):
        """The timeout is opt-in: unset means unbounded, as before."""
        graph = create_agent_graph()
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=0.3))

        result = graph.run()
        assert result.nodes["slow"].status == "success"

    def test_abandoned_worker_is_a_daemon_so_it_cannot_block_exit(self):
        before = set(threading.enumerate())

        graph = create_agent_graph({"node_timeout": 100})
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=5.0))
        assert graph.run().nodes["slow"].status == "error"

        survivors = [
            t for t in threading.enumerate()
            if t not in before and t.is_alive()
        ]
        # Anti-vacuity: `all(...)` over an empty list passes and proves nothing,
        # so first pin that the abandoned worker really is still running.
        assert survivors, "expected the abandoned node worker to still be alive"
        non_daemon = [t.name for t in survivors if not t.daemon]
        assert not non_daemon, (
            "these workers outlive the timeout as non-daemon threads and will "
            f"block interpreter exit until the node finishes: {non_daemon}"
        )

    def test_timeout_applies_on_the_sequential_path_too(self):
        """run() has two dispatch branches; parallel=False must be bounded too."""
        graph = create_agent_graph({"node_timeout": 100, "parallel": False})
        graph.add_node(name="slow", agent=SlowAgent("Slow", delay=5.0))

        started = time.time()
        result = graph.run()
        elapsed = time.time() - started

        assert result.nodes["slow"].status == "error"
        assert elapsed < 1.0, f"sequential path took {elapsed:.2f}s for a 100ms timeout"
