"""Tests for AgentGraph - DAG executor for parallel agent pipelines."""

import json
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
