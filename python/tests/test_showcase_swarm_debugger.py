"""Tests for Showcase: Swarm Debugger - BroadcastManager race + fix agent."""

import asyncio
import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.broadcast import BroadcastManager


class LogAnalyzerAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "LogAnalyzer", "description": "Analyzes logs", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="LogAnalyzer", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "diagnosis": "Found null pointer in auth middleware at line 42",
            "confidence": 0.85,
            "data_slush": {"source_agent": "LogAnalyzer", "diagnosis": "null_pointer", "file": "src/auth.ts", "line": 42},
        })


class StackTraceParserAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "StackTraceParser", "description": "Parses stack traces", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="StackTraceParser", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "diagnosis": "TypeError in user validation pipeline",
            "confidence": 0.78,
            "data_slush": {"source_agent": "StackTraceParser", "diagnosis": "type_error"},
        })


class ErrorCategorizerAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "ErrorCategorizer", "description": "Categorizes errors", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="ErrorCategorizer", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "diagnosis": "Runtime error, severity: critical",
            "confidence": 0.90,
            "data_slush": {"source_agent": "ErrorCategorizer", "diagnosis": "runtime_error", "severity": "critical"},
        })


class FixSuggestionAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "FixSuggestion", "description": "Suggests fixes", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="FixSuggestion", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush")
        diagnosis = upstream.get("diagnosis") if upstream else None
        source = upstream.get("source_agent") if upstream else "unknown"
        return json.dumps({
            "status": "success",
            "fix": f"Fix for {diagnosis}" if diagnosis else "No diagnosis available",
            "based_on": source,
            "data_slush": {"source_agent": "FixSuggestion", "applied": True},
        })


def _make_agents():
    return {
        "LogAnalyzer": LogAnalyzerAgent(),
        "StackTraceParser": StackTraceParserAgent(),
        "ErrorCategorizer": ErrorCategorizerAgent(),
        "FixSuggestion": FixSuggestionAgent(),
    }


class TestRaceMode:
    def test_race_3_debug_agents(self):
        agents = _make_agents()
        mgr = BroadcastManager()
        mgr.create_group({"id": "debug-swarm", "name": "Debug Swarm", "agentIds": ["LogAnalyzer", "StackTraceParser", "ErrorCategorizer"], "mode": "race"})

        async def executor(agent_id, message, upstream_slush=None):
            agent = agents[agent_id]
            result_str = agent.execute(query=message)
            return json.loads(result_str)

        result = asyncio.get_event_loop().run_until_complete(mgr.broadcast("debug-swarm", "NullPointerException in auth", executor))
        assert result["anySucceeded"] is True
        assert result["firstResponse"] is not None

    def test_all_mode_collects_all_diagnoses(self):
        agents = _make_agents()
        mgr = BroadcastManager()
        mgr.create_group({"id": "debug-all", "name": "Debug All", "agentIds": ["LogAnalyzer", "StackTraceParser", "ErrorCategorizer"], "mode": "all"})

        async def executor(agent_id, message, upstream_slush=None):
            agent = agents[agent_id]
            result_str = agent.execute(query=message)
            return json.loads(result_str)

        result = asyncio.get_event_loop().run_until_complete(mgr.broadcast("debug-all", "Diagnose error", executor))
        assert result["allSucceeded"] is True
        assert len(result["results"]) == 3


class TestWinnerSlushForwarding:
    def test_forward_winner_slush_to_fix_agent(self):
        agents = _make_agents()
        mgr = BroadcastManager()
        mgr.create_group({"id": "debug-swarm", "name": "Debug Swarm", "agentIds": ["LogAnalyzer", "StackTraceParser", "ErrorCategorizer"], "mode": "race"})

        async def executor(agent_id, message, upstream_slush=None):
            agent = agents[agent_id]
            result_str = agent.execute(query=message)
            return json.loads(result_str)

        race_result = asyncio.get_event_loop().run_until_complete(mgr.broadcast("debug-swarm", "Auth error", executor))
        winner_result = race_result["firstResponse"]["result"]
        winner_slush = winner_result.get("data_slush", {})

        fix_agent = agents["FixSuggestion"]
        fix_result_str = fix_agent.execute(query="suggest fix", upstream_slush=winner_slush)
        fix_result = json.loads(fix_result_str)
        assert fix_result["status"] == "success"
        assert fix_result["based_on"] in ["LogAnalyzer", "StackTraceParser", "ErrorCategorizer"]


class TestErrorHandling:
    def test_throw_for_unknown_group(self):
        mgr = BroadcastManager()
        async def executor(agent_id, message, upstream_slush=None):
            return {"status": "success"}
        with pytest.raises(ValueError, match="not found"):
            asyncio.get_event_loop().run_until_complete(mgr.broadcast("nonexistent", "test", executor))

    def test_race_with_single_agent(self):
        agents = _make_agents()
        mgr = BroadcastManager()
        mgr.create_group({"id": "single", "name": "Single", "agentIds": ["LogAnalyzer"], "mode": "race"})

        async def executor(agent_id, message, upstream_slush=None):
            return json.loads(agents[agent_id].execute(query=message))

        result = asyncio.get_event_loop().run_until_complete(mgr.broadcast("single", "test", executor))
        assert result["anySucceeded"] is True
