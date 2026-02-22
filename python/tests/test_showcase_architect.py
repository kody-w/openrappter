"""Tests for Showcase: The Architect - LearnNewAgent + AgentGraph DAG."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.graph import AgentGraph, GraphNode


class DataValidatorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "DataValidator", "description": "Validates data records", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="DataValidator", metadata=metadata)

    def perform(self, **kwargs):
        records = kwargs.get("records", [])
        return json.dumps({
            "status": "success",
            "validCount": len(records),
            "invalidCount": 0,
            "data_slush": {"source_agent": "DataValidator", "validated": True, "record_count": len(records), "schema_version": "1.0"},
        })


class TransformerAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Transformer", "description": "Transforms validated data", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Transformer", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        return json.dumps({
            "status": "success",
            "transformed": True,
            "received_upstream": upstream is not None,
            "data_slush": {"source_agent": "Transformer", "format": "normalized", "transformations_applied": ["lowercase", "trim", "dedupe"]},
        })


class ReporterAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Reporter", "description": "Generates final report", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Reporter", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        upstream_keys = list(upstream.keys()) if upstream else []
        return json.dumps({
            "status": "success",
            "report": "Data pipeline complete",
            "upstream_sources": upstream_keys,
            "data_slush": {"source_agent": "Reporter", "report_generated": True, "summary": {"sources": len(upstream_keys)}},
        })


class FailingValidator(BasicAgent):
    def __init__(self):
        metadata = {"name": "FailingValidator", "description": "Always fails", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="FailingValidator", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("Validation failed: corrupt data")


class TestDAGWiring:
    def test_wire_3_agents_into_linear_dag(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=DataValidatorAgent()))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=ReporterAgent(), depends_on=["validate", "transform"]))
        assert graph.length == 3
        validation = graph.validate()
        assert validation["valid"] is True

    def test_execute_dag_in_correct_order(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=DataValidatorAgent(), kwargs={"records": [1, 2, 3]}))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=ReporterAgent(), depends_on=["validate", "transform"]))
        result = graph.run()
        assert result.status == "success"
        order = result.execution_order
        assert order.index("validate") < order.index("transform")
        assert order.index("transform") < order.index("report")

    def test_propagate_data_slush_through_dag(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=DataValidatorAgent(), kwargs={"records": [1, 2, 3]}))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=ReporterAgent(), depends_on=["validate", "transform"]))
        result = graph.run()
        validate_result = result.nodes["validate"]
        assert validate_result.data_slush is not None
        report_result = result.nodes["report"]
        assert report_result.status == "success"
        report_parsed = report_result.result
        assert "validate" in report_parsed["upstream_sources"]
        assert "transform" in report_parsed["upstream_sources"]

    def test_merge_slush_from_all_upstream_nodes(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=DataValidatorAgent(), kwargs={"records": ["a", "b"]}))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=ReporterAgent(), depends_on=["validate", "transform"]))
        result = graph.run()
        report_parsed = result.nodes["report"].result
        sources = report_parsed["upstream_sources"]
        assert "validate" in sources
        assert "transform" in sources
        assert len(sources) == 2


class TestErrorPropagation:
    def test_skip_downstream_nodes_when_upstream_fails(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=FailingValidator()))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=ReporterAgent(), depends_on=["transform"]))
        result = graph.run()
        assert result.status == "partial"
        assert result.nodes["validate"].status == "error"
        assert result.nodes["transform"].status == "skipped"
        assert result.nodes["report"].status == "skipped"

    def test_stop_immediately_with_stop_on_error(self):
        graph = AgentGraph({"stop_on_error": True})
        graph.add_node(GraphNode(name="validate", agent=FailingValidator()))
        graph.add_node(GraphNode(name="transform", agent=TransformerAgent(), depends_on=["validate"]))
        result = graph.run()
        assert result.status == "error"
        assert result.error is not None


class TestRuntimeCreation:
    def test_dynamically_create_agents_and_wire_into_graph(self):
        agents = [DataValidatorAgent(), TransformerAgent(), ReporterAgent()]
        assert len(agents) == 3
        assert [a.name for a in agents] == ["DataValidator", "Transformer", "Reporter"]
        graph = AgentGraph()
        graph.add_node(GraphNode(name="validate", agent=agents[0], kwargs={"records": ["x", "y"]}))
        graph.add_node(GraphNode(name="transform", agent=agents[1], depends_on=["validate"]))
        graph.add_node(GraphNode(name="report", agent=agents[2], depends_on=["validate", "transform"]))
        result = graph.run()
        assert result.status == "success"
        assert len(result.nodes) == 3
