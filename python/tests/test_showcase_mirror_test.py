"""Tests for Showcase: Mirror Test - Parallel parity comparison via AgentGraph."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.graph import AgentGraph, GraphNode


class SentimentAgentA(BasicAgent):
    def __init__(self, sentiment="positive"):
        self._sentiment = sentiment
        metadata = {"name": "SentimentA", "description": "Sentiment A", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="SentimentA", metadata=metadata)

    def perform(self, **kwargs):
        text = kwargs.get("text", "")
        return json.dumps({
            "status": "success",
            "sentiment": self._sentiment,
            "confidence": 0.92,
            "word_count": len(text.split()),
            "data_slush": {"source_agent": "SentimentA", "sentiment": self._sentiment, "confidence": 0.92, "implementation": "A"},
        })


class SentimentAgentB(BasicAgent):
    def __init__(self, sentiment="positive"):
        self._sentiment = sentiment
        metadata = {"name": "SentimentB", "description": "Sentiment B", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="SentimentB", metadata=metadata)

    def perform(self, **kwargs):
        text = kwargs.get("text", "")
        return json.dumps({
            "status": "success",
            "sentiment": self._sentiment,
            "confidence": 0.89,
            "word_count": len(text.split()),
            "data_slush": {"source_agent": "SentimentB", "sentiment": self._sentiment, "confidence": 0.89, "implementation": "B"},
        })


class ComparatorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Comparator", "description": "Compares outputs", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Comparator", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        if not upstream:
            return json.dumps({"status": "error", "message": "No upstream data"})
        slush_a = upstream.get("sentimentA", {})
        slush_b = upstream.get("sentimentB", {})
        sentiment_match = slush_a.get("sentiment") == slush_b.get("sentiment")
        conf_a = slush_a.get("confidence", 0)
        conf_b = slush_b.get("confidence", 0)
        confidence_delta = abs(conf_a - conf_b)
        return json.dumps({
            "status": "success",
            "parity": sentiment_match,
            "confidence_delta": confidence_delta,
            "implementations_compared": list(upstream.keys()),
            "data_slush": {"source_agent": "Comparator", "parity": sentiment_match, "confidence_delta": confidence_delta},
        })


class TestParityDetection:
    def test_detect_matching_outputs(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="sentimentA", agent=SentimentAgentA("positive"), kwargs={"text": "great product"}))
        graph.add_node(GraphNode(name="sentimentB", agent=SentimentAgentB("positive"), kwargs={"text": "great product"}))
        graph.add_node(GraphNode(name="compare", agent=ComparatorAgent(), depends_on=["sentimentA", "sentimentB"]))
        result = graph.run()
        assert result.status == "success"
        compare_result = result.nodes["compare"].result
        assert compare_result["parity"] is True
        assert "sentimentA" in compare_result["implementations_compared"]
        assert "sentimentB" in compare_result["implementations_compared"]

    def test_detect_mismatched_outputs(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="sentimentA", agent=SentimentAgentA("positive"), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="sentimentB", agent=SentimentAgentB("negative"), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="compare", agent=ComparatorAgent(), depends_on=["sentimentA", "sentimentB"]))
        result = graph.run()
        compare_result = result.nodes["compare"].result
        assert compare_result["parity"] is False


class TestParallelExecution:
    def test_run_both_sentiment_agents(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="sentimentA", agent=SentimentAgentA(), kwargs={"text": "hello world"}))
        graph.add_node(GraphNode(name="sentimentB", agent=SentimentAgentB(), kwargs={"text": "hello world"}))
        graph.add_node(GraphNode(name="compare", agent=ComparatorAgent(), depends_on=["sentimentA", "sentimentB"]))
        result = graph.run()
        assert result.status == "success"
        assert len(result.nodes) == 3
        assert result.execution_order.index("compare") == 2

    def test_receive_multi_upstream_slush(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="sentimentA", agent=SentimentAgentA(), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="sentimentB", agent=SentimentAgentB(), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="compare", agent=ComparatorAgent(), depends_on=["sentimentA", "sentimentB"]))
        result = graph.run()
        compare_result = result.nodes["compare"].result
        assert len(compare_result["implementations_compared"]) == 2


class TestConfidenceDelta:
    def test_compute_confidence_delta(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="sentimentA", agent=SentimentAgentA(), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="sentimentB", agent=SentimentAgentB(), kwargs={"text": "test"}))
        graph.add_node(GraphNode(name="compare", agent=ComparatorAgent(), depends_on=["sentimentA", "sentimentB"]))
        result = graph.run()
        compare_result = result.nodes["compare"].result
        assert abs(compare_result["confidence_delta"] - 0.03) < 0.01
