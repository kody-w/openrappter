"""Tests for Showcase: Watchmaker Tournament - Competing agents + evaluator."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.graph import AgentGraph, GraphNode


class CompetitorAgent(BasicAgent):
    def __init__(self, name, quality, solution):
        self._quality = quality
        self._solution = solution
        metadata = {"name": name, "description": f"Competitor with quality {quality}", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "solution": self._solution,
            "quality": self._quality,
            "data_slush": {"source_agent": self.name, "quality": self._quality, "solution": self._solution, "approach": f"{self.name}-approach"},
        })


class TournamentEvaluatorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Evaluator", "description": "Evaluates tournament", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Evaluator", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        if not upstream:
            return json.dumps({"status": "error", "message": "No competitors found"})
        competitors = [{"name": name, "quality": slush.get("quality", 0), "solution": slush.get("solution", ""), "approach": slush.get("approach", "")} for name, slush in upstream.items()]
        competitors.sort(key=lambda c: c["quality"], reverse=True)
        winner = competitors[0]
        return json.dumps({
            "status": "success",
            "winner": winner["name"],
            "winner_quality": winner["quality"],
            "winner_solution": winner["solution"],
            "rankings": [{"name": c["name"], "quality": c["quality"]} for c in competitors],
            "competitors_count": len(competitors),
            "data_slush": {"source_agent": "Evaluator", "winner": winner["name"], "winner_quality": winner["quality"]},
        })


class FailComp(BasicAgent):
    def __init__(self):
        metadata = {"name": "FailComp", "description": "Fails", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="FailComp", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("Competitor crashed")


class TestTournamentExecution:
    def test_run_3_competitors_then_evaluate(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 50, "brute force")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 90, "dynamic programming")))
        graph.add_node(GraphNode(name="comp-c", agent=CompetitorAgent("CompC", 70, "greedy algorithm")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b", "comp-c"]))
        result = graph.run()
        assert result.status == "success"
        assert len(result.nodes) == 4
        assert result.execution_order.index("evaluator") == 3

    def test_pick_highest_quality_winner(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 50, "brute force")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 90, "dynamic programming")))
        graph.add_node(GraphNode(name="comp-c", agent=CompetitorAgent("CompC", 70, "greedy algorithm")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b", "comp-c"]))
        result = graph.run()
        eval_result = result.nodes["evaluator"].result
        assert eval_result["winner"] == "comp-b"
        assert eval_result["winner_quality"] == 90
        assert eval_result["winner_solution"] == "dynamic programming"


class TestRankings:
    def test_rank_competitors_by_quality(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 50, "sol-a")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 90, "sol-b")))
        graph.add_node(GraphNode(name="comp-c", agent=CompetitorAgent("CompC", 70, "sol-c")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b", "comp-c"]))
        result = graph.run()
        rankings = result.nodes["evaluator"].result["rankings"]
        assert len(rankings) == 3
        assert rankings[0]["quality"] == 90
        assert rankings[1]["quality"] == 70
        assert rankings[2]["quality"] == 50

    def test_count_all_competitors(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 50, "a")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 90, "b")))
        graph.add_node(GraphNode(name="comp-c", agent=CompetitorAgent("CompC", 70, "c")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b", "comp-c"]))
        result = graph.run()
        assert result.nodes["evaluator"].result["competitors_count"] == 3


class TestTwoCompetitors:
    def test_work_with_2_competitors(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 60, "sol-a")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 80, "sol-b")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b"]))
        result = graph.run()
        assert result.nodes["evaluator"].result["winner"] == "comp-b"
        assert result.nodes["evaluator"].result["competitors_count"] == 2


class TestTieBreaking:
    def test_handle_tied_scores(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 80, "sol-a")))
        graph.add_node(GraphNode(name="comp-b", agent=CompetitorAgent("CompB", 80, "sol-b")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b"]))
        result = graph.run()
        assert result.nodes["evaluator"].result["winner_quality"] == 80
        assert result.nodes["evaluator"].result["winner"] in ["comp-a", "comp-b"]


class TestCompetitorFailure:
    def test_skip_evaluator_if_competitor_fails(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="comp-a", agent=CompetitorAgent("CompA", 50, "sol-a")))
        graph.add_node(GraphNode(name="comp-b", agent=FailComp()))
        graph.add_node(GraphNode(name="comp-c", agent=CompetitorAgent("CompC", 70, "sol-c")))
        graph.add_node(GraphNode(name="evaluator", agent=TournamentEvaluatorAgent(), depends_on=["comp-a", "comp-b", "comp-c"]))
        result = graph.run()
        assert result.status == "partial"
        assert result.nodes["comp-b"].status == "error"
        assert result.nodes["evaluator"].status == "skipped"
