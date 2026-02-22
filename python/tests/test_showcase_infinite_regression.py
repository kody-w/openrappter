"""Tests for Showcase: Infinite Regression - SubAgentManager depth limits + loop detection."""

import asyncio
import pytest

from openrappter.agents.subagent import SubAgentManager


def push_call(context, target_agent_id):
    """Manually push a call record into context history for loop detection testing."""
    import time, random
    call = {
        "id": f"call_{int(time.time())}_{random.randint(0, 999999)}",
        "parentAgentId": context.get("parentAgentId", ""),
        "targetAgentId": target_agent_id,
        "message": "test",
        "depth": context.get("depth", 0),
        "startedAt": "",
        "status": "success",
    }
    context["history"].append(call)


class TestDepthLimits:
    def test_allow_invocation_within_depth_limit(self):
        manager = SubAgentManager({"maxDepth": 5})
        assert manager.can_invoke("LearnNew", 0) is True
        assert manager.can_invoke("LearnNew", 4) is True

    def test_deny_invocation_at_max_depth(self):
        manager = SubAgentManager({"maxDepth": 5})
        assert manager.can_invoke("LearnNew", 5) is False
        assert manager.can_invoke("LearnNew", 10) is False

    def test_throw_error_when_invoking_at_max_depth(self):
        async def async_executor(*args, **kwargs):
            return {"status": "success"}

        manager = SubAgentManager({"maxDepth": 3})
        manager.set_executor(async_executor)
        ctx = manager.create_context("RecursiveCreator")
        ctx["depth"] = 3
        with pytest.raises(RuntimeError, match="Cannot invoke agent LearnNew"):
            asyncio.get_event_loop().run_until_complete(manager.invoke("LearnNew", "create agent", ctx))

    def test_increment_depth_on_child_context(self):
        manager = SubAgentManager({"maxDepth": 5})
        captured_depth = [-1]

        async def executor(agent_id, message, context, upstream_slush=None):
            captured_depth[0] = context.get("depth", -1)
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Parent")
        assert ctx["depth"] == 0
        asyncio.get_event_loop().run_until_complete(manager.invoke("ChildAgent", "do work", ctx))
        assert captured_depth[0] == 1

    def test_track_nested_depth_across_invocations(self):
        manager = SubAgentManager({"maxDepth": 5})
        depths = []

        async def executor(agent_id, message, context, upstream_slush=None):
            depths.append(context.get("depth", -1))
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Root")
        asyncio.get_event_loop().run_until_complete(manager.invoke("Agent1", "step 1", ctx))

        ctx2 = dict(ctx)
        ctx2["depth"] = 2
        ctx2["callId"] = "call_2"
        ctx2["parentAgentId"] = "Agent1"
        ctx2["history"] = list(ctx["history"])
        asyncio.get_event_loop().run_until_complete(manager.invoke("Agent2", "step 2", ctx2))
        assert depths == [1, 3]


class TestLoopDetection:
    def test_detect_repeated_invocations(self):
        manager = SubAgentManager({"maxDepth": 10})

        async def executor(agent_id, message, context, upstream_slush=None):
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Orchestrator")
        push_call(ctx, "LearnNew")
        push_call(ctx, "LearnNew")
        push_call(ctx, "LearnNew")
        with pytest.raises(RuntimeError, match="loop detected"):
            asyncio.get_event_loop().run_until_complete(manager.invoke("LearnNew", "call 4", ctx))

    def test_allow_different_agents_without_loop(self):
        manager = SubAgentManager({"maxDepth": 10})

        async def executor(agent_id, message, context, upstream_slush=None):
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Orchestrator")
        push_call(ctx, "AgentA")
        push_call(ctx, "AgentB")
        push_call(ctx, "AgentC")
        result = asyncio.get_event_loop().run_until_complete(manager.invoke("AgentA", "task 4", ctx))
        assert result is not None

    def test_detect_loops_within_sliding_window(self):
        manager = SubAgentManager({"maxDepth": 20})

        async def executor(agent_id, message, context, upstream_slush=None):
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Root")
        push_call(ctx, "A")
        push_call(ctx, "B")
        push_call(ctx, "C")
        push_call(ctx, "Target")
        push_call(ctx, "Target")
        push_call(ctx, "Target")
        with pytest.raises(RuntimeError, match="loop detected"):
            asyncio.get_event_loop().run_until_complete(manager.invoke("Target", "msg", ctx))


class TestBlockedAgents:
    def test_deny_blocked_agents(self):
        manager = SubAgentManager({"maxDepth": 5, "blockedAgents": ["DangerousAgent"]})
        assert manager.can_invoke("DangerousAgent", 0) is False
        assert manager.can_invoke("SafeAgent", 0) is True


class TestAllowedAgents:
    def test_only_allow_specified_agents(self):
        manager = SubAgentManager({"maxDepth": 5, "allowedAgents": ["LearnNew", "Memory"]})
        assert manager.can_invoke("LearnNew", 0) is True
        assert manager.can_invoke("Memory", 0) is True
        assert manager.can_invoke("Shell", 0) is False


class TestCallHistory:
    def test_record_call_history(self):
        manager = SubAgentManager({"maxDepth": 5})

        async def executor(agent_id, message, context, upstream_slush=None):
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("Root")
        asyncio.get_event_loop().run_until_complete(manager.invoke("AgentA", "task 1", ctx))
        asyncio.get_event_loop().run_until_complete(manager.invoke("AgentB", "task 2", ctx))
        history = manager.get_call_history()
        assert len(history) == 2
        assert history[0]["targetAgentId"] == "AgentA"
        assert history[0]["status"] == "success"
        assert history[1]["targetAgentId"] == "AgentB"

    def test_record_errors_in_history(self):
        manager = SubAgentManager({"maxDepth": 5})

        async def executor(agent_id, message, context, upstream_slush=None):
            raise RuntimeError("Agent crashed")

        manager.set_executor(executor)
        ctx = manager.create_context("Root")
        with pytest.raises(RuntimeError):
            asyncio.get_event_loop().run_until_complete(manager.invoke("CrashAgent", "do work", ctx))
        history = manager.get_call_history()
        assert len(history) == 1
        assert history[0]["status"] == "error"
        assert "Agent crashed" in history[0]["error"]


class TestGracefulFailure:
    def test_throw_without_executor(self):
        manager = SubAgentManager({"maxDepth": 5})
        ctx = manager.create_context("Root")
        with pytest.raises(RuntimeError, match="No agent executor configured"):
            asyncio.get_event_loop().run_until_complete(manager.invoke("Agent", "msg", ctx))
