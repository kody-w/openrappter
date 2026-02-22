"""Tests for Showcase: Code Archaeologist - AgentGraph fan-out/fan-in."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.graph import AgentGraph, GraphNode


class GitHistoryAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "GitHistory", "description": "Analyzes git history", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="GitHistory", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "commits": 142,
            "authors": ["alice", "bob", "charlie"],
            "hotspots": ["src/auth.ts", "src/api/routes.ts"],
            "data_slush": {"source_agent": "GitHistory", "analysis_type": "git_history", "commit_count": 142, "top_authors": ["alice", "bob"], "hotspot_files": ["src/auth.ts", "src/api/routes.ts"]},
        })


class DependencyAnalyzerAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "DependencyAnalyzer", "description": "Analyzes dependencies", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="DependencyAnalyzer", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "totalDeps": 24,
            "outdated": 3,
            "vulnerable": 1,
            "data_slush": {"source_agent": "DependencyAnalyzer", "analysis_type": "dependencies", "total": 24, "outdated": ["lodash@3.x", "moment@2.x", "express@4.x"], "vulnerable": ["lodash@3.x"]},
        })


class ComplexityScorerAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "ComplexityScorer", "description": "Measures complexity", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="ComplexityScorer", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "averageCyclomaticComplexity": 4.2,
            "maxComplexity": 18,
            "highComplexityFiles": ["src/auth.ts", "src/parser.ts"],
            "data_slush": {"source_agent": "ComplexityScorer", "analysis_type": "complexity", "avg_complexity": 4.2, "max_complexity": 18, "risky_files": ["src/auth.ts", "src/parser.ts"]},
        })


class SynthesisAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Synthesis", "description": "Merges findings", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Synthesis", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        sources = list(upstream.keys()) if upstream else []
        analysis_types = [upstream[s].get("analysis_type") for s in sources] if upstream else []
        git_hotspots = upstream.get("git", {}).get("hotspot_files", []) if upstream else []
        complex_risky = upstream.get("complexity", {}).get("risky_files", []) if upstream else []
        cross_referenced = [f for f in git_hotspots if f in complex_risky]
        return json.dumps({
            "status": "success",
            "synthesis": {
                "sources_merged": len(sources),
                "analysis_types": analysis_types,
                "cross_referenced_risks": cross_referenced,
                "recommendation": f"Priority refactor: {', '.join(cross_referenced)}" if cross_referenced else "No critical cross-references found",
            },
            "data_slush": {"source_agent": "Synthesis", "sources_merged": len(sources), "cross_referenced": cross_referenced},
        })


class FailingAnalyzer(BasicAgent):
    def __init__(self):
        metadata = {"name": "FailingAnalyzer", "description": "Fails", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="FailingAnalyzer", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("Analysis failed")


class TestFanOutFanIn:
    def test_run_3_analyzers_then_synthesize(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent(), kwargs={"repo": "/test/repo"}))
        graph.add_node(GraphNode(name="deps", agent=DependencyAnalyzerAgent()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        graph.add_node(GraphNode(name="synthesis", agent=SynthesisAgent(), depends_on=["git", "deps", "complexity"]))
        result = graph.run()
        assert result.status == "success"
        assert len(result.nodes) == 4
        assert result.execution_order.index("synthesis") == 3

    def test_merge_all_upstream_slush(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent()))
        graph.add_node(GraphNode(name="deps", agent=DependencyAnalyzerAgent()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        graph.add_node(GraphNode(name="synthesis", agent=SynthesisAgent(), depends_on=["git", "deps", "complexity"]))
        result = graph.run()
        synthesis = result.nodes["synthesis"].result["synthesis"]
        assert synthesis["sources_merged"] == 3
        assert "git_history" in synthesis["analysis_types"]
        assert "dependencies" in synthesis["analysis_types"]
        assert "complexity" in synthesis["analysis_types"]

    def test_cross_reference_hotspots_and_complex_files(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent()))
        graph.add_node(GraphNode(name="deps", agent=DependencyAnalyzerAgent()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        graph.add_node(GraphNode(name="synthesis", agent=SynthesisAgent(), depends_on=["git", "deps", "complexity"]))
        result = graph.run()
        synthesis = result.nodes["synthesis"].result["synthesis"]
        assert "src/auth.ts" in synthesis["cross_referenced_risks"]
        assert "src/auth.ts" in synthesis["recommendation"]


class TestIndividualAnalyzerOutput:
    def test_valid_data_slush_from_each_analyzer(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent()))
        graph.add_node(GraphNode(name="deps", agent=DependencyAnalyzerAgent()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        result = graph.run()
        assert result.nodes["git"].data_slush["source_agent"] == "GitHistory"
        assert result.nodes["git"].data_slush["analysis_type"] == "git_history"
        assert result.nodes["deps"].data_slush["source_agent"] == "DependencyAnalyzer"
        assert result.nodes["complexity"].data_slush["source_agent"] == "ComplexityScorer"


class TestParallelPerformance:
    def test_synthesis_is_always_last(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent()))
        graph.add_node(GraphNode(name="deps", agent=DependencyAnalyzerAgent()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        graph.add_node(GraphNode(name="synthesis", agent=SynthesisAgent(), depends_on=["git", "deps", "complexity"]))
        result = graph.run()
        assert result.execution_order.index("synthesis") == len(result.execution_order) - 1


class TestPartialFailure:
    def test_skip_synthesis_if_analyzer_fails(self):
        graph = AgentGraph()
        graph.add_node(GraphNode(name="git", agent=GitHistoryAgent()))
        graph.add_node(GraphNode(name="deps", agent=FailingAnalyzer()))
        graph.add_node(GraphNode(name="complexity", agent=ComplexityScorerAgent()))
        graph.add_node(GraphNode(name="synthesis", agent=SynthesisAgent(), depends_on=["git", "deps", "complexity"]))
        result = graph.run()
        assert result.status == "partial"
        assert result.nodes["deps"].status == "error"
        assert result.nodes["synthesis"].status == "skipped"
