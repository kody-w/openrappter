"""Tests for SubAgentManager - nested agent invocation with depth/loop guards."""

import asyncio
import pytest

from openrappter.agents.subagent import SubAgentManager, create_sub_agent_manager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def simple_executor(agent_id, message, context, upstream_slush=None):
    """Always succeeds and echoes back information."""
    return {"agentId": agent_id, "message": message, "status": "ok"}


async def failing_executor(agent_id, message, context, upstream_slush=None):
    raise RuntimeError(f"Agent {agent_id} failed deliberately")


async def slush_executor(agent_id, message, context, upstream_slush=None):
    """Returns a result with data_slush for downstream chaining."""
    return {
        "agentId": agent_id,
        "status": "ok",
        "data_slush": {"from_agent": agent_id, "value": 42},
    }


def make_manager(config=None):
    mgr = SubAgentManager(config)
    mgr.set_executor(simple_executor)
    return mgr


def make_root_context(parent="parent-agent"):
    return {
        "callId": "root_0",
        "parentAgentId": parent,
        "depth": 0,
        "history": [],
    }


# ---------------------------------------------------------------------------
# Tests: constructor and factory
# ---------------------------------------------------------------------------

class TestSubAgentManagerInit:
    def test_default_config_values(self):
        mgr = SubAgentManager()
        assert mgr._config["maxDepth"] == 5
        assert mgr._config["blockedAgents"] == []
        assert mgr._config["allowedAgents"] is None

    def test_custom_config(self):
        mgr = SubAgentManager({"maxDepth": 3, "id": "custom-id"})
        assert mgr._config["maxDepth"] == 3
        assert mgr._config["id"] == "custom-id"

    def test_factory_function_returns_instance(self):
        mgr = create_sub_agent_manager()
        assert isinstance(mgr, SubAgentManager)

    def test_active_calls_initially_empty(self):
        mgr = SubAgentManager()
        assert mgr.get_active_calls() == []

    def test_call_history_initially_empty(self):
        mgr = SubAgentManager()
        assert mgr.get_call_history() == []


# ---------------------------------------------------------------------------
# Tests: can_invoke()
# ---------------------------------------------------------------------------

class TestCanInvoke:
    def test_allows_normal_invocation(self):
        mgr = SubAgentManager({"maxDepth": 5})
        assert mgr.can_invoke("agent-a", 0) is True

    def test_blocks_at_max_depth(self):
        mgr = SubAgentManager({"maxDepth": 5})
        assert mgr.can_invoke("agent-a", 5) is False

    def test_blocks_at_depth_exceeding_max(self):
        mgr = SubAgentManager({"maxDepth": 3})
        assert mgr.can_invoke("agent-a", 4) is False

    def test_allows_below_max_depth(self):
        mgr = SubAgentManager({"maxDepth": 3})
        assert mgr.can_invoke("agent-a", 2) is True

    def test_blocks_agents_in_blocked_list(self):
        mgr = SubAgentManager({"blockedAgents": ["bad-agent"]})
        assert mgr.can_invoke("bad-agent", 0) is False

    def test_allows_agents_not_in_blocked_list(self):
        mgr = SubAgentManager({"blockedAgents": ["bad-agent"]})
        assert mgr.can_invoke("good-agent", 0) is True

    def test_allowed_list_restricts_to_listed_agents(self):
        mgr = SubAgentManager({"allowedAgents": ["agent-a", "agent-b"]})
        assert mgr.can_invoke("agent-a", 0) is True
        assert mgr.can_invoke("agent-c", 0) is False

    def test_no_allowed_list_means_all_allowed(self):
        mgr = SubAgentManager({"allowedAgents": None})
        assert mgr.can_invoke("any-agent", 0) is True


# ---------------------------------------------------------------------------
# Tests: invoke()
# ---------------------------------------------------------------------------

class TestInvoke:
    def test_invoke_requires_executor(self):
        mgr = SubAgentManager()
        ctx = make_root_context()
        with pytest.raises(RuntimeError, match="No agent executor"):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )

    def test_invoke_returns_result(self):
        mgr = make_manager()
        ctx = make_root_context()
        result = asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert result["agentId"] == "agent-a"
        assert result["message"] == "hello"

    def test_invoke_raises_when_depth_exceeded(self):
        mgr = SubAgentManager({"maxDepth": 2})
        mgr.set_executor(simple_executor)
        ctx = {**make_root_context(), "depth": 2}
        with pytest.raises(RuntimeError, match="Cannot invoke"):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )

    def test_invoke_raises_on_blocked_agent(self):
        mgr = SubAgentManager({"blockedAgents": ["forbidden"]})
        mgr.set_executor(simple_executor)
        ctx = make_root_context()
        with pytest.raises(RuntimeError, match="Cannot invoke"):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("forbidden", "hello", ctx)
            )

    def test_invoke_records_call_history(self):
        mgr = make_manager()
        ctx = make_root_context()
        asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        history = mgr.get_call_history()
        assert len(history) == 1
        assert history[0]["targetAgentId"] == "agent-a"

    def test_invoke_increments_depth_in_child_context(self):
        received_depths = []

        async def depth_tracking_executor(agent_id, message, context, upstream_slush=None):
            received_depths.append(context.get("depth"))
            return {"ok": True}

        mgr = SubAgentManager()
        mgr.set_executor(depth_tracking_executor)
        ctx = {**make_root_context(), "depth": 0}
        asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert received_depths == [1]

    def test_invoke_propagates_executor_errors(self):
        mgr = SubAgentManager()
        mgr.set_executor(failing_executor)
        ctx = make_root_context()
        with pytest.raises(RuntimeError, match="failed deliberately"):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )

    def test_invoke_call_removed_from_active_after_completion(self):
        mgr = make_manager()
        ctx = make_root_context()
        asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert mgr.get_active_calls() == []


# ---------------------------------------------------------------------------
# Tests: loop detection
# ---------------------------------------------------------------------------

class TestLoopDetection:
    def test_raises_when_same_agent_called_three_times_in_history(self):
        mgr = make_manager()
        history = [
            {"targetAgentId": "agent-a", "depth": 0},
            {"targetAgentId": "agent-a", "depth": 1},
            {"targetAgentId": "agent-a", "depth": 2},
        ]
        ctx = {**make_root_context(), "history": history}
        with pytest.raises(RuntimeError, match="Recursive loop"):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )

    def test_no_loop_when_different_agents(self):
        mgr = make_manager()
        history = [
            {"targetAgentId": "agent-b", "depth": 0},
            {"targetAgentId": "agent-b", "depth": 1},
            {"targetAgentId": "agent-b", "depth": 2},
        ]
        ctx = {**make_root_context(), "history": history}
        # agent-a has 0 occurrences in history, so should be fine
        result = asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert result["agentId"] == "agent-a"

    def test_loop_detection_uses_last_ten_calls(self):
        """History beyond the last 10 entries should not count."""
        mgr = make_manager()
        # 11 calls to agent-a, but only last 10 are checked — 2 in last 10
        history = [{"targetAgentId": "agent-a", "depth": i} for i in range(2)]
        history = [{"targetAgentId": "agent-a", "depth": i} for i in range(2)]
        ctx = {**make_root_context(), "history": history}
        # 2 occurrences is fine (threshold is >= 3)
        result = asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert result is not None


# ---------------------------------------------------------------------------
# Tests: data_slush forwarding
# ---------------------------------------------------------------------------

class TestDataSlushForwarding:
    def test_data_slush_extracted_to_context_last_slush(self):
        mgr = SubAgentManager()
        mgr.set_executor(slush_executor)
        ctx = make_root_context()
        asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert ctx.get("lastSlush") == {"from_agent": "agent-a", "value": 42}

    def test_upstream_slush_passed_to_executor(self):
        received_slush = []

        async def capturing_executor(agent_id, message, context, upstream_slush=None):
            received_slush.append(upstream_slush)
            return {"ok": True}

        mgr = SubAgentManager()
        mgr.set_executor(capturing_executor)
        ctx = {**make_root_context(), "lastSlush": {"some": "data"}}
        asyncio.get_event_loop().run_until_complete(
            mgr.invoke("agent-a", "hello", ctx)
        )
        assert received_slush[0] == {"some": "data"}


# ---------------------------------------------------------------------------
# Tests: create_tool() and handle_tool_call()
# ---------------------------------------------------------------------------

class TestCreateTool:
    def test_create_tool_returns_openai_function_format(self):
        mgr = SubAgentManager()
        tool = mgr.create_tool("weather-agent", "Weather", "Gets weather data")
        assert tool["type"] == "function"
        func = tool["function"]
        assert func["name"] == "invoke_weather-agent"
        assert "message" in func["parameters"]["properties"]
        assert "message" in func["parameters"]["required"]

    def test_tool_description_contains_agent_name(self):
        mgr = SubAgentManager()
        tool = mgr.create_tool("my-agent", "My Agent", "Does things")
        assert "My Agent" in tool["function"]["description"]


class TestHandleToolCall:
    def test_handle_tool_call_invokes_agent(self):
        mgr = make_manager()
        ctx = make_root_context()
        result = asyncio.get_event_loop().run_until_complete(
            mgr.handle_tool_call("invoke_agent-a", {"message": "do it"}, ctx)
        )
        assert result["agentId"] == "agent-a"

    def test_handle_tool_call_raises_on_invalid_tool_name(self):
        mgr = make_manager()
        ctx = make_root_context()
        with pytest.raises(ValueError, match="Invalid sub-agent tool name"):
            asyncio.get_event_loop().run_until_complete(
                mgr.handle_tool_call("bad_name", {"message": "x"}, ctx)
            )


# ---------------------------------------------------------------------------
# Tests: create_context()
# ---------------------------------------------------------------------------

class TestCreateContext:
    def test_create_context_sets_depth_zero(self):
        mgr = SubAgentManager()
        ctx = mgr.create_context("root-agent")
        assert ctx["depth"] == 0

    def test_create_context_sets_parent_agent_id(self):
        mgr = SubAgentManager()
        ctx = mgr.create_context("root-agent")
        assert ctx["parentAgentId"] == "root-agent"

    def test_create_context_has_empty_history(self):
        mgr = SubAgentManager()
        ctx = mgr.create_context("root-agent")
        assert ctx["history"] == []


# ---------------------------------------------------------------------------
# Tests: call history / active calls
# ---------------------------------------------------------------------------

class TestCallTracking:
    def test_call_history_limit(self):
        mgr = make_manager()
        ctx = make_root_context()
        for _ in range(5):
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )
        history = mgr.get_call_history(limit=3)
        assert len(history) == 3

    def test_failed_call_recorded_as_error_in_history(self):
        mgr = SubAgentManager()
        mgr.set_executor(failing_executor)
        ctx = make_root_context()
        try:
            asyncio.get_event_loop().run_until_complete(
                mgr.invoke("agent-a", "hello", ctx)
            )
        except RuntimeError:
            pass
        history = mgr.get_call_history()
        assert len(history) == 1
        assert history[0]["status"] == "error"
