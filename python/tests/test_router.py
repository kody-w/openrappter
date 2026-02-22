"""Tests for AgentRouter - rule-based message routing."""

import pytest

from openrappter.agents.router import AgentRouter, create_agent_router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_context(sender="user1", channel="ch1", conversation="conv1", message="hello"):
    return {
        "senderId": sender,
        "channelId": channel,
        "conversationId": conversation,
        "message": message,
    }


def make_rule(rule_id, agent_id, priority=0, conditions=None):
    if conditions is None:
        conditions = [{"type": "always"}]
    return {
        "id": rule_id,
        "priority": priority,
        "conditions": conditions,
        "agentId": agent_id,
    }


# ---------------------------------------------------------------------------
# Tests: constructor
# ---------------------------------------------------------------------------

class TestAgentRouterInit:
    def test_default_agent_is_default(self):
        router = AgentRouter()
        result = router.route(make_context())
        assert result["agentId"] == "default"

    def test_no_rules_initially(self):
        router = AgentRouter()
        assert router.get_rules() == []

    def test_factory_function_returns_instance(self):
        router = create_agent_router()
        assert isinstance(router, AgentRouter)


# ---------------------------------------------------------------------------
# Tests: adding / removing rules
# ---------------------------------------------------------------------------

class TestRuleManagement:
    def test_add_rule_appears_in_get_rules(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a"))
        rules = router.get_rules()
        assert len(rules) == 1
        assert rules[0]["id"] == "r1"

    def test_rules_sorted_by_priority_descending(self):
        router = AgentRouter()
        router.add_rule(make_rule("low", "agent-low", priority=1))
        router.add_rule(make_rule("high", "agent-high", priority=10))
        router.add_rule(make_rule("mid", "agent-mid", priority=5))
        ids = [r["id"] for r in router.get_rules()]
        assert ids == ["high", "mid", "low"]

    def test_remove_rule_returns_true(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a"))
        removed = router.remove_rule("r1")
        assert removed is True

    def test_remove_rule_actually_removes(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a"))
        router.remove_rule("r1")
        assert router.get_rules() == []

    def test_remove_missing_rule_returns_false(self):
        router = AgentRouter()
        removed = router.remove_rule("nonexistent")
        assert removed is False


# ---------------------------------------------------------------------------
# Tests: routing – default when no rules match
# ---------------------------------------------------------------------------

class TestDefaultRouting:
    def test_uses_default_when_no_rules(self):
        router = AgentRouter()
        result = router.route(make_context())
        assert result["agentId"] == "default"

    def test_set_default_agent(self):
        router = AgentRouter()
        router.set_default_agent("my-agent")
        result = router.route(make_context())
        assert result["agentId"] == "my-agent"

    def test_result_has_session_key(self):
        router = AgentRouter()
        result = router.route(make_context())
        assert "sessionKey" in result


# ---------------------------------------------------------------------------
# Tests: routing by condition type
# ---------------------------------------------------------------------------

class TestRoutingBySender:
    def test_sender_condition_matches(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-for-alice", conditions=[
            {"type": "sender", "value": "alice"}
        ]))
        result = router.route(make_context(sender="alice"))
        assert result["agentId"] == "agent-for-alice"

    def test_sender_condition_does_not_match_other_sender(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-for-alice", conditions=[
            {"type": "sender", "value": "alice"}
        ]))
        result = router.route(make_context(sender="bob"))
        assert result["agentId"] == "default"

    def test_sender_condition_exact_match(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a", conditions=[
            {"type": "sender", "value": "alice123"}
        ]))
        # Partial match should NOT trigger
        result = router.route(make_context(sender="alice"))
        assert result["agentId"] == "default"


class TestRoutingByChannel:
    def test_channel_condition_matches(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "slack-agent", conditions=[
            {"type": "channel", "value": "slack"}
        ]))
        result = router.route(make_context(channel="slack"))
        assert result["agentId"] == "slack-agent"

    def test_channel_condition_does_not_match_other_channel(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "slack-agent", conditions=[
            {"type": "channel", "value": "slack"}
        ]))
        result = router.route(make_context(channel="discord"))
        assert result["agentId"] == "default"


class TestRoutingByGroup:
    def test_group_condition_matches_conversation_id(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "group-agent", conditions=[
            {"type": "group", "value": "convo-42"}
        ]))
        result = router.route(make_context(conversation="convo-42"))
        assert result["agentId"] == "group-agent"

    def test_group_condition_does_not_match_other_conversation(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "group-agent", conditions=[
            {"type": "group", "value": "convo-42"}
        ]))
        result = router.route(make_context(conversation="convo-99"))
        assert result["agentId"] == "default"


class TestRoutingByPattern:
    def test_pattern_condition_matches_message_regex(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "help-agent", conditions=[
            {"type": "pattern", "value": r"\bhelp\b"}
        ]))
        result = router.route(make_context(message="I need help please"))
        assert result["agentId"] == "help-agent"

    def test_pattern_condition_case_insensitive(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "help-agent", conditions=[
            {"type": "pattern", "value": "help"}
        ]))
        result = router.route(make_context(message="HELP ME"))
        assert result["agentId"] == "help-agent"

    def test_pattern_condition_does_not_match(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "help-agent", conditions=[
            {"type": "pattern", "value": r"\bhelp\b"}
        ]))
        result = router.route(make_context(message="I am fine"))
        assert result["agentId"] == "default"

    def test_pattern_key_takes_precedence_over_value(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "tech-agent", conditions=[
            {"type": "pattern", "pattern": r"\b(python|typescript)\b"}
        ]))
        result = router.route(make_context(message="I love python"))
        assert result["agentId"] == "tech-agent"


class TestRoutingAlways:
    def test_always_condition_matches_any_message(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "catch-all", conditions=[{"type": "always"}]))
        result = router.route(make_context(message="anything at all"))
        assert result["agentId"] == "catch-all"


class TestRoutingUnknownCondition:
    def test_unknown_condition_type_does_not_match(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a", conditions=[
            {"type": "unsupported_type", "value": "x"}
        ]))
        result = router.route(make_context())
        assert result["agentId"] == "default"


# ---------------------------------------------------------------------------
# Tests: priority-based routing
# ---------------------------------------------------------------------------

class TestPriorityRouting:
    def test_higher_priority_rule_wins(self):
        router = AgentRouter()
        router.add_rule(make_rule("low", "low-agent", priority=1,
                                  conditions=[{"type": "always"}]))
        router.add_rule(make_rule("high", "high-agent", priority=100,
                                  conditions=[{"type": "always"}]))
        result = router.route(make_context())
        assert result["agentId"] == "high-agent"

    def test_matched_rule_is_returned_in_result(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "agent-a", priority=5,
                                  conditions=[{"type": "always"}]))
        result = router.route(make_context())
        assert result.get("rule") is not None
        assert result["rule"]["id"] == "r1"

    def test_no_rule_key_when_using_default(self):
        router = AgentRouter()
        result = router.route(make_context())
        assert "rule" not in result


# ---------------------------------------------------------------------------
# Tests: multi-condition rules (AND semantics)
# ---------------------------------------------------------------------------

class TestMultiConditionRules:
    def test_all_conditions_must_match(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "strict-agent", conditions=[
            {"type": "sender", "value": "alice"},
            {"type": "channel", "value": "slack"},
        ]))
        # Only sender matches
        result = router.route(make_context(sender="alice", channel="discord"))
        assert result["agentId"] == "default"

    def test_all_conditions_match_routes_correctly(self):
        router = AgentRouter()
        router.add_rule(make_rule("r1", "strict-agent", conditions=[
            {"type": "sender", "value": "alice"},
            {"type": "channel", "value": "slack"},
        ]))
        result = router.route(make_context(sender="alice", channel="slack"))
        assert result["agentId"] == "strict-agent"


# ---------------------------------------------------------------------------
# Tests: session key formats
# ---------------------------------------------------------------------------

class TestSessionKeys:
    def test_conversation_format_uses_channel_and_conversation(self):
        router = AgentRouter()
        router.set_session_key_format("conversation")
        result = router.route(make_context(channel="slack", conversation="conv-1"))
        assert result["sessionKey"] == "slack:conv-1"

    def test_sender_format_uses_channel_and_sender(self):
        router = AgentRouter()
        router.set_session_key_format("sender")
        result = router.route(make_context(channel="slack", sender="alice"))
        assert result["sessionKey"] == "slack:alice"

    def test_channel_format_uses_only_channel(self):
        router = AgentRouter()
        router.set_session_key_format("channel")
        result = router.route(make_context(channel="discord"))
        assert result["sessionKey"] == "discord"

    def test_custom_format_uses_provided_function(self):
        router = AgentRouter()
        router.set_session_key_format("custom", lambda ctx: f"custom:{ctx['senderId']}")
        result = router.route(make_context(sender="bob"))
        assert result["sessionKey"] == "custom:bob"

    def test_default_format_is_conversation(self):
        router = AgentRouter()
        result = router.route(make_context(channel="ch1", conversation="cv1"))
        assert result["sessionKey"] == "ch1:cv1"


# ---------------------------------------------------------------------------
# Tests: load_rules helper
# ---------------------------------------------------------------------------

class TestLoadRules:
    def test_load_rules_from_config(self):
        router = AgentRouter()
        router.load_rules([
            {"id": "r1", "priority": 5, "sender": "alice", "agent": "alice-agent"},
            {"id": "r2", "priority": 1, "channel": "slack", "agent": "slack-agent"},
        ])
        assert len(router.get_rules()) == 2

    def test_load_rules_sender_condition(self):
        router = AgentRouter()
        router.load_rules([
            {"id": "r1", "priority": 5, "sender": "alice", "agent": "alice-agent"}
        ])
        result = router.route(make_context(sender="alice"))
        assert result["agentId"] == "alice-agent"

    def test_load_rules_always_when_no_condition(self):
        router = AgentRouter()
        router.load_rules([
            {"id": "r1", "agent": "catch-all-agent"}
        ])
        result = router.route(make_context())
        assert result["agentId"] == "catch-all-agent"
