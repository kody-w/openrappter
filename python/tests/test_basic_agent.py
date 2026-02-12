"""Tests for BasicAgent - data sloshing, signals, context, and slush_out."""

import json
import pytest
from datetime import datetime
from unittest.mock import patch, PropertyMock

from openrappter.agents.basic_agent import BasicAgent


class StubAgent(BasicAgent):
    """Minimal agent for testing BasicAgent behavior."""

    def __init__(self):
        super().__init__(
            name="Stub",
            metadata={
                "name": "Stub",
                "description": "Test stub",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        )

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "echo": kwargs.get("query", "")})


class SlushAgent(BasicAgent):
    """Agent that returns data_slush in its output."""

    def __init__(self):
        super().__init__(
            name="Slush",
            metadata={
                "name": "Slush",
                "description": "Returns data_slush",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        )

    def perform(self, **kwargs):
        return json.dumps({
            "status": "success",
            "data_slush": {
                "source_agent": self.name,
                "temp_f": 72,
                "mood": "sunny",
            },
        })


# --- Constructor & metadata ---

class TestBasicAgentInit:
    def test_name_and_metadata_set(self):
        agent = StubAgent()
        assert agent.name == "Stub"
        assert agent.metadata["name"] == "Stub"
        assert agent.metadata["description"] == "Test stub"

    def test_context_starts_empty(self):
        agent = StubAgent()
        assert agent.context == {}

    def test_last_data_slush_initially_none(self):
        agent = StubAgent()
        assert agent.last_data_slush is None


# --- execute() flow ---

class TestExecute:
    def test_execute_calls_perform(self):
        agent = StubAgent()
        result = json.loads(agent.execute(query="hello"))
        assert result["status"] == "success"
        assert result["echo"] == "hello"

    def test_execute_populates_context(self):
        agent = StubAgent()
        agent.execute(query="test")
        assert "temporal" in agent.context
        assert "query_signals" in agent.context
        assert "orientation" in agent.context

    def test_execute_passes_context_to_perform(self):
        class ContextCheckAgent(BasicAgent):
            def __init__(self):
                super().__init__("Check", {"name": "Check", "description": "", "parameters": {"type": "object", "properties": {}, "required": []}})

            def perform(self, **kwargs):
                ctx = kwargs.get("_context", {})
                return json.dumps({"has_temporal": "temporal" in ctx})

        agent = ContextCheckAgent()
        result = json.loads(agent.execute(query="x"))
        assert result["has_temporal"] is True


# --- Data slush extraction ---

class TestDataSlush:
    def test_execute_extracts_data_slush(self):
        agent = SlushAgent()
        agent.execute(query="weather")
        assert agent.last_data_slush is not None
        assert agent.last_data_slush["source_agent"] == "Slush"
        assert agent.last_data_slush["temp_f"] == 72

    def test_no_data_slush_when_absent(self):
        agent = StubAgent()
        agent.execute(query="hello")
        assert agent.last_data_slush is None

    def test_upstream_slush_merged_into_context(self):
        agent = StubAgent()
        upstream = {"source_agent": "Weather", "temp_f": 65}
        agent.execute(query="test", upstream_slush=upstream)
        assert agent.context["upstream_slush"] == upstream

    def test_upstream_slush_not_present_when_not_provided(self):
        agent = StubAgent()
        agent.execute(query="test")
        assert "upstream_slush" not in agent.context


# --- slush_out() helper ---

class TestSlushOut:
    def test_slush_out_includes_source_agent(self):
        agent = StubAgent()
        agent.execute(query="x")
        slush = agent.slush_out()
        assert slush["source_agent"] == "Stub"
        assert "timestamp" in slush

    def test_slush_out_custom_agent_name(self):
        agent = StubAgent()
        agent.context = {}
        slush = agent.slush_out(agent_name="Custom")
        assert slush["source_agent"] == "Custom"

    def test_slush_out_with_signals(self):
        agent = StubAgent()
        agent.context = {}
        slush = agent.slush_out(signals={"key": "value"})
        assert slush["signals"] == {"key": "value"}

    def test_slush_out_with_confidence(self):
        agent = StubAgent()
        agent.context = {}
        slush = agent.slush_out(confidence="high")
        assert slush["confidence"] == "high"

    def test_slush_out_with_extra_kwargs(self):
        agent = StubAgent()
        agent.context = {}
        slush = agent.slush_out(mood="happy", score=99)
        assert slush["mood"] == "happy"
        assert slush["score"] == 99

    def test_slush_out_includes_orientation_from_context(self):
        agent = StubAgent()
        agent.execute(query="test")
        slush = agent.slush_out()
        assert "orientation" in slush


# --- Temporal sloshing ---

class TestTemporalSloshing:
    def test_temporal_has_expected_keys(self):
        agent = StubAgent()
        temporal = agent._slosh_temporal()
        expected_keys = {"time_of_day", "day_of_week", "is_weekend", "quarter", "fiscal", "likely_activity", "is_urgent_period"}
        assert expected_keys == set(temporal.keys())

    def test_quarter_format(self):
        agent = StubAgent()
        temporal = agent._slosh_temporal()
        assert temporal["quarter"] in ["Q1", "Q2", "Q3", "Q4"]

    def test_day_of_week_is_string(self):
        agent = StubAgent()
        temporal = agent._slosh_temporal()
        assert temporal["day_of_week"] in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    def test_is_weekend_boolean(self):
        agent = StubAgent()
        temporal = agent._slosh_temporal()
        assert isinstance(temporal["is_weekend"], bool)


# --- Query signal sloshing ---

class TestQuerySloshing:
    def test_empty_query(self):
        agent = StubAgent()
        signals = agent._slosh_query("")
        assert signals["specificity"] == "low"
        assert signals["hints"] == []

    def test_temporal_hints(self):
        agent = StubAgent()
        signals = agent._slosh_query("show me latest updates")
        assert "temporal:recency" in signals["hints"]

    def test_ownership_hints(self):
        agent = StubAgent()
        signals = agent._slosh_query("show my tasks")
        assert "ownership:user" in signals["hints"]

    def test_team_ownership(self):
        agent = StubAgent()
        signals = agent._slosh_query("show our team progress")
        assert "ownership:team" in signals["hints"]

    def test_uuid_gives_high_specificity(self):
        agent = StubAgent()
        signals = agent._slosh_query("find item a1b2c3d4-e5f6")
        assert signals["specificity"] == "high"
        assert signals["has_id_pattern"] is True

    def test_word_count(self):
        agent = StubAgent()
        signals = agent._slosh_query("hello world foo")
        assert signals["word_count"] == 3

    def test_is_question(self):
        agent = StubAgent()
        assert agent._slosh_query("what is this?")["is_question"] is True
        assert agent._slosh_query("do this")["is_question"] is False


# --- get_signal() ---

class TestGetSignal:
    def test_dot_notation(self):
        agent = StubAgent()
        agent.execute(query="hello")
        val = agent.get_signal("temporal.time_of_day")
        assert val is not None
        assert isinstance(val, str)

    def test_top_level_key(self):
        agent = StubAgent()
        agent.execute(query="hello")
        val = agent.get_signal("temporal")
        assert isinstance(val, dict)

    def test_missing_key_returns_default(self):
        agent = StubAgent()
        agent.context = {}
        assert agent.get_signal("nonexistent", "fallback") == "fallback"

    def test_deep_missing_key(self):
        agent = StubAgent()
        agent.context = {"temporal": {"time_of_day": "morning"}}
        assert agent.get_signal("temporal.nonexistent", "nope") == "nope"


# --- Orientation synthesis ---

class TestOrientation:
    def test_high_specificity_gives_high_confidence(self):
        agent = StubAgent()
        context = {
            "query_signals": {"specificity": "high", "hints": []},
            "priors": {},
            "temporal": {},
            "behavioral": {},
        }
        orientation = agent._synthesize_orientation(context)
        assert orientation["confidence"] == "high"
        assert orientation["approach"] == "direct"

    def test_low_specificity_gives_low_confidence(self):
        agent = StubAgent()
        context = {
            "query_signals": {"specificity": "low", "hints": []},
            "priors": {},
            "temporal": {},
            "behavioral": {},
        }
        orientation = agent._synthesize_orientation(context)
        assert orientation["confidence"] == "low"
        assert orientation["approach"] == "clarify"

    def test_priors_give_high_confidence(self):
        agent = StubAgent()
        context = {
            "query_signals": {"specificity": "low", "hints": []},
            "priors": {"tool": {"preferred": "vim", "confidence": 0.85}},
            "temporal": {},
            "behavioral": {},
        }
        orientation = agent._synthesize_orientation(context)
        assert orientation["confidence"] == "high"
        assert orientation["approach"] == "use_preference"

    def test_recency_hint_generates_sort_hint(self):
        agent = StubAgent()
        context = {
            "query_signals": {"specificity": "low", "hints": ["temporal:recency"]},
            "priors": {},
            "temporal": {},
            "behavioral": {},
        }
        orientation = agent._synthesize_orientation(context)
        assert "Sort by most recent" in orientation["hints"]

    def test_brief_preference_affects_style(self):
        agent = StubAgent()
        context = {
            "query_signals": {"specificity": "low", "hints": []},
            "priors": {},
            "temporal": {},
            "behavioral": {"prefers_brief": True},
        }
        orientation = agent._synthesize_orientation(context)
        assert orientation["response_style"] == "concise"
