"""Tests for Showcase: Data Sloshing Deep Dive — Full Slosh Pipeline."""

import json
import pytest
import re

from openrappter.agents.basic_agent import BasicAgent


class SloshTestAgent(BasicAgent):
    """A test agent that captures self.context in perform() to inspect sloshing."""

    def __init__(self):
        metadata = {
            "name": "SloshTest",
            "description": "Captures context for slosh inspection",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="SloshTest", metadata=metadata)
        self.captured_context = None

    def perform(self, **kwargs):
        self.captured_context = dict(self.context)
        return json.dumps({"status": "ok"})


class TestDefaultSlosh:
    def test_default_slosh_populates_all_five_signal_categories(self):
        """Default slosh populates all 5 signal categories without filters."""
        agent = SloshTestAgent()
        agent.execute(query="show me the latest reports")

        ctx = agent.captured_context

        # All 5 categories must be present
        assert "temporal" in ctx, "temporal category missing from context"
        assert "query_signals" in ctx, "query_signals category missing from context"
        assert "memory_echoes" in ctx, "memory_echoes category missing from context"
        assert "behavioral" in ctx, "behavioral category missing from context"
        assert "priors" in ctx, "priors category missing from context"

        # temporal should have expected keys
        temporal = ctx["temporal"]
        assert "time_of_day" in temporal
        assert "day_of_week" in temporal
        assert "quarter" in temporal
        assert "fiscal" in temporal
        assert "is_weekend" in temporal
        assert "is_urgent_period" in temporal

        # query_signals should have expected keys
        qs = ctx["query_signals"]
        assert "specificity" in qs
        assert "hints" in qs
        assert "word_count" in qs
        assert "is_question" in qs

        # behavioral should have expected keys
        beh = ctx["behavioral"]
        assert "prefers_brief" in beh
        assert "technical_level" in beh
        assert "frequent_entities" in beh

        # orientation should be synthesized
        assert "orientation" in ctx
        orientation = ctx["orientation"]
        assert "confidence" in orientation
        assert "approach" in orientation


class TestSloshFilter:
    def test_filter_include_only_populates_specified_categories(self):
        """SloshFilter include: only specified categories populated, others zeroed."""
        agent = SloshTestAgent()
        agent.slosh_filter = {"include": ["temporal", "query_signals"]}
        agent.execute(query="what is the status today?")

        ctx = agent.captured_context

        # Included categories should have real data
        assert ctx["temporal"] != {}, "temporal should be populated (included)"
        qs = ctx["query_signals"]
        assert isinstance(qs, dict), "query_signals should be a dict"
        # 'today' in query should trigger temporal:today hint
        assert "hints" in qs

        # Excluded categories should be zeroed to their defaults
        assert ctx["memory_echoes"] == [], "memory_echoes should be empty list (excluded)"
        beh = ctx["behavioral"]
        assert beh["prefers_brief"] is False, "behavioral.prefers_brief should be False (excluded)"
        assert beh["technical_level"] == "standard", "behavioral.technical_level should be 'standard' (excluded)"
        assert beh["frequent_entities"] == [], "behavioral.frequent_entities should be [] (excluded)"
        assert ctx["priors"] == {}, "priors should be empty dict (excluded)"

    def test_filter_exclude_zeroes_specified_categories(self):
        """SloshFilter exclude: specified categories zeroed, others populated normally."""
        agent = SloshTestAgent()
        agent.slosh_filter = {"exclude": ["behavioral", "priors"]}
        agent.execute(query="show pipeline status")

        ctx = agent.captured_context

        # Non-excluded categories should have data
        assert ctx["temporal"] != {}, "temporal should be populated (not excluded)"
        assert isinstance(ctx["query_signals"], dict), "query_signals should be populated"
        assert "specificity" in ctx["query_signals"]

        # Excluded categories should be zeroed
        beh = ctx["behavioral"]
        assert beh["prefers_brief"] is False, "behavioral.prefers_brief should be False (excluded)"
        assert beh["technical_level"] == "standard", "behavioral.technical_level should be 'standard' (excluded)"
        assert ctx["priors"] == {}, "priors should be empty dict (excluded)"


class TestSloshPrivacy:
    def test_privacy_redact_deletes_specified_field_paths(self):
        """SloshPrivacy redact: deletes specified field paths from signals."""
        agent = SloshTestAgent()
        agent.slosh_privacy = {"redact": ["temporal.time_of_day", "temporal.fiscal"]}
        agent.execute(query="check schedules")

        ctx = agent.captured_context
        temporal = ctx["temporal"]

        # Redacted paths should be deleted (not present)
        assert "time_of_day" not in temporal, "time_of_day should have been redacted (deleted)"
        assert "fiscal" not in temporal, "fiscal should have been redacted (deleted)"

        # Other temporal fields should still be present
        assert "day_of_week" in temporal, "day_of_week should still be present"
        assert "quarter" in temporal, "quarter should still be present"

    def test_privacy_obfuscate_replaces_values_with_hash(self):
        """SloshPrivacy obfuscate: replaces values with [obfuscated:<hash>] pattern."""
        agent = SloshTestAgent()
        agent.slosh_privacy = {"obfuscate": ["temporal.time_of_day", "temporal.day_of_week"]}
        agent.execute(query="check my schedule")

        ctx = agent.captured_context
        temporal = ctx["temporal"]

        # Obfuscated fields should match [obfuscated:<8-char hex hash>] pattern
        obfuscated_pattern = re.compile(r"^\[obfuscated:[0-9a-f]{8}\]$")

        assert "time_of_day" in temporal, "time_of_day key should still exist after obfuscation"
        assert obfuscated_pattern.match(str(temporal["time_of_day"])), (
            f"time_of_day should match obfuscation pattern, got: {temporal['time_of_day']}"
        )

        assert "day_of_week" in temporal, "day_of_week key should still exist after obfuscation"
        assert obfuscated_pattern.match(str(temporal["day_of_week"])), (
            f"day_of_week should match obfuscation pattern, got: {temporal['day_of_week']}"
        )

        # Non-obfuscated fields should retain their original value format
        assert "quarter" in temporal
        assert not obfuscated_pattern.match(str(temporal["quarter"])), (
            "quarter should NOT be obfuscated"
        )


class TestSloshDebug:
    def test_slosh_debug_captures_four_stages(self):
        """SloshDebug captures 4 debug event stages: post-slosh, post-filter, post-privacy, post-perform."""
        agent = SloshTestAgent()
        agent.slosh_debug = True
        agent.slosh_filter = {"include": ["temporal"]}
        agent.slosh_privacy = {"obfuscate": ["temporal.quarter"]}

        debug_events = []
        agent.on_slosh_debug = lambda event: debug_events.append(event)

        agent.execute(query="debug test query")

        stages = [e["stage"] for e in debug_events]

        assert "post-slosh" in stages, "post-slosh debug stage should be emitted"
        assert "post-filter" in stages, "post-filter debug stage should be emitted"
        assert "post-privacy" in stages, "post-privacy debug stage should be emitted"
        assert "post-perform" in stages, "post-perform debug stage should be emitted"
        assert len(stages) == 4, f"Exactly 4 debug stages expected, got: {stages}"

        # Each event should have 'stage', 'timestamp', and 'context' keys
        for event in debug_events:
            assert "stage" in event
            assert "timestamp" in event
            assert "context" in event

    def test_slosh_debug_off_by_default_emits_no_events(self):
        """SloshDebug is off by default — no events emitted without enabling it."""
        agent = SloshTestAgent()

        debug_events = []
        agent.on_slosh_debug = lambda event: debug_events.append(event)
        # slosh_debug remains False (default)

        agent.execute(query="quiet execution")

        assert len(debug_events) == 0, "No debug events should be emitted when slosh_debug is False"


class TestSignalFeedback:
    def test_feedback_loop_accumulates_utility_scores(self):
        """Signal feedback loop: utility scores accumulate with decay, auto-suppress at threshold."""
        agent = SloshTestAgent()
        agent.signal_decay = 1.0  # Disable decay so scores accumulate cleanly

        # Override perform to emit slosh_feedback marking behavioral as useless
        call_count = [0]

        def perform_with_feedback(**kwargs):
            call_count[0] += 1
            agent.captured_context = dict(agent.context)
            return json.dumps({
                "status": "ok",
                "slosh_feedback": {
                    "useful_signals": ["temporal.time_of_day"],
                    "useless_signals": ["behavioral.prefers_brief"],
                },
            })

        agent.perform = perform_with_feedback

        # Execute twice to accumulate scores
        agent.execute(query="first call")
        agent.execute(query="second call")

        # temporal.time_of_day should have positive score (+1 per call)
        assert agent.signal_utility.get("temporal.time_of_day", 0) > 0, (
            "temporal.time_of_day should have positive utility score"
        )

        # behavioral.prefers_brief should have negative score (-1 per call)
        assert agent.signal_utility.get("behavioral.prefers_brief", 0) < 0, (
            "behavioral.prefers_brief should have negative utility score"
        )

    def test_auto_suppress_zeroes_category_at_threshold(self):
        """Categories with cumulative scores at/below auto_suppress_threshold are suppressed."""
        agent = SloshTestAgent()
        agent.signal_decay = 1.0  # Disable decay
        agent.auto_suppress_threshold = -2  # Suppress when score <= -2

        call_count = [0]

        def perform_with_negative_feedback(**kwargs):
            call_count[0] += 1
            agent.captured_context = dict(agent.context)
            return json.dumps({
                "status": "ok",
                "slosh_feedback": {
                    "useful_signals": [],
                    "useless_signals": ["behavioral.prefers_brief", "behavioral.technical_level"],
                },
            })

        agent.perform = perform_with_negative_feedback

        # Execute enough times to push behavioral below threshold (-2 for 2 signals x 2 calls)
        agent.execute(query="call one")
        agent.execute(query="call two")
        agent.execute(query="call three - should suppress behavioral")

        # On the third call, behavioral should be auto-suppressed (score <= -2 by second call)
        ctx = agent.captured_context
        beh = ctx["behavioral"]
        # After auto-suppress, behavioral should be zeroed to defaults
        assert beh["prefers_brief"] is False, "behavioral.prefers_brief should be suppressed to False"
        assert beh["technical_level"] == "standard", "behavioral.technical_level should be suppressed to 'standard'"


class TestGetSignal:
    def test_get_signal_resolves_dot_notation_paths(self):
        """getSignal() dot-notation resolves nested paths with defaults for missing keys."""
        agent = SloshTestAgent()
        agent.execute(query="current quarter revenue")

        # Resolve a nested signal via dot-notation
        time_of_day = agent.get_signal("temporal.time_of_day")
        assert time_of_day is not None, "temporal.time_of_day should resolve to a value"
        assert isinstance(time_of_day, str), "time_of_day should be a string"

        quarter = agent.get_signal("temporal.quarter")
        assert quarter is not None
        assert quarter.startswith("Q"), f"quarter should start with 'Q', got: {quarter}"

        # Resolve word_count from query_signals
        word_count = agent.get_signal("query_signals.word_count")
        assert word_count is not None
        assert word_count == 3, f"query 'current quarter revenue' has 3 words, got: {word_count}"

    def test_get_signal_returns_default_for_missing_path(self):
        """getSignal() returns the provided default when the path does not exist."""
        agent = SloshTestAgent()
        agent.execute(query="test")

        missing = agent.get_signal("temporal.nonexistent_key", "fallback_value")
        assert missing == "fallback_value", (
            f"Missing key should return default 'fallback_value', got: {missing}"
        )

        deep_missing = agent.get_signal("no_category.no_key", 42)
        assert deep_missing == 42, f"Deep missing path should return default 42, got: {deep_missing}"

    def test_get_signal_top_level_key(self):
        """getSignal() without dot-notation retrieves top-level context keys."""
        agent = SloshTestAgent()
        agent.execute(query="test signal")

        orientation = agent.get_signal("orientation")
        assert orientation is not None, "orientation should be accessible via top-level get_signal"
        assert "confidence" in orientation


class TestBreadcrumbs:
    def test_breadcrumbs_accumulate_newest_first(self):
        """Breadcrumbs accumulate in LIFO order — most recent at index 0."""
        agent = SloshTestAgent()

        agent.execute(query="first query")
        agent.execute(query="second query")
        agent.execute(query="third query")

        crumbs = agent.breadcrumbs
        assert len(crumbs) >= 3, "Should have at least 3 breadcrumbs"

        # Most recent should be at index 0 (LIFO)
        assert crumbs[0]["query"] == "third query", (
            f"Most recent query should be first, got: {crumbs[0]['query']}"
        )
        assert crumbs[1]["query"] == "second query", (
            f"Second most recent should be at index 1, got: {crumbs[1]['query']}"
        )
        assert crumbs[2]["query"] == "first query", (
            f"Oldest query should be at index 2, got: {crumbs[2]['query']}"
        )

    def test_breadcrumbs_respect_max_breadcrumbs_limit(self):
        """Breadcrumbs list is capped at max_breadcrumbs — oldest entries are dropped."""
        agent = SloshTestAgent()
        agent.max_breadcrumbs = 3

        for i in range(6):
            agent.execute(query=f"query {i}")

        assert len(agent.breadcrumbs) == 3, (
            f"Breadcrumbs should be capped at max_breadcrumbs=3, got: {len(agent.breadcrumbs)}"
        )

        # Most recent (query 5) should be at the top
        assert agent.breadcrumbs[0]["query"] == "query 5", (
            f"Most recent should be query 5, got: {agent.breadcrumbs[0]['query']}"
        )

    def test_breadcrumbs_include_timestamp_and_confidence(self):
        """Each breadcrumb entry includes timestamp and confidence fields."""
        agent = SloshTestAgent()
        agent.execute(query="breadcrumb inspection test")

        crumb = agent.breadcrumbs[0]
        assert "query" in crumb, "breadcrumb should have 'query' field"
        assert "timestamp" in crumb, "breadcrumb should have 'timestamp' field"
        assert "confidence" in crumb, "breadcrumb should have 'confidence' field"
        assert crumb["query"] == "breadcrumb inspection test"
