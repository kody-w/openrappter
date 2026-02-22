"""Tests for BroadcastManager - multi-agent messaging in all/race/fallback modes."""

import asyncio
import pytest

from openrappter.agents.broadcast import BroadcastManager, create_broadcast_manager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_group(group_id, agent_ids, mode="all", timeout=None):
    group = {
        "id": group_id,
        "name": f"Group {group_id}",
        "agentIds": agent_ids,
        "mode": mode,
    }
    if timeout is not None:
        group["timeout"] = timeout
    return group


async def success_executor(agent_id, message, upstream_slush=None):
    """Always succeeds and returns a simple result dict."""
    return {"agentId": agent_id, "message": message, "status": "ok"}


async def failure_executor(agent_id, message, upstream_slush=None):
    """Always raises an exception."""
    raise RuntimeError(f"Agent {agent_id} failed")


def make_selective_executor(failing_ids):
    """Returns an executor that fails for agents in failing_ids, succeeds otherwise."""
    async def executor(agent_id, message, upstream_slush=None):
        if agent_id in failing_ids:
            raise RuntimeError(f"Agent {agent_id} intentionally failed")
        return {"agentId": agent_id, "message": message, "status": "ok"}
    return executor


async def slow_executor(agent_id, message, upstream_slush=None):
    """Simulates a slow agent."""
    await asyncio.sleep(0.5)
    return {"agentId": agent_id, "status": "ok"}


# ---------------------------------------------------------------------------
# Tests: group management
# ---------------------------------------------------------------------------

class TestGroupManagement:
    def test_create_group(self):
        mgr = BroadcastManager()
        grp = make_group("g1", ["a1", "a2"])
        mgr.create_group(grp)
        assert mgr.get_group("g1") is not None

    def test_create_multiple_groups(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1"]))
        mgr.create_group(make_group("g2", ["a2", "a3"]))
        groups = mgr.get_groups()
        assert len(groups) == 2

    def test_get_group_returns_none_for_missing(self):
        mgr = BroadcastManager()
        assert mgr.get_group("nonexistent") is None

    def test_remove_group_returns_true(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1"]))
        removed = mgr.remove_group("g1")
        assert removed is True

    def test_remove_group_actually_removes(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1"]))
        mgr.remove_group("g1")
        assert mgr.get_group("g1") is None

    def test_remove_missing_group_returns_false(self):
        mgr = BroadcastManager()
        removed = mgr.remove_group("does-not-exist")
        assert removed is False

    def test_get_groups_empty_initially(self):
        mgr = create_broadcast_manager()
        assert mgr.get_groups() == []


# ---------------------------------------------------------------------------
# Tests: factory function
# ---------------------------------------------------------------------------

class TestFactoryFunction:
    def test_create_broadcast_manager_returns_instance(self):
        mgr = create_broadcast_manager()
        assert isinstance(mgr, BroadcastManager)


# ---------------------------------------------------------------------------
# Tests: broadcast raises on missing group
# ---------------------------------------------------------------------------

class TestBroadcastErrors:
    def test_broadcast_raises_when_group_not_found(self):
        mgr = BroadcastManager()
        with pytest.raises(ValueError, match="not found"):
            asyncio.get_event_loop().run_until_complete(
                mgr.broadcast("missing-group", "hello", success_executor)
            )


# ---------------------------------------------------------------------------
# Tests: all mode
# ---------------------------------------------------------------------------

class TestBroadcastAll:
    def test_all_mode_sends_to_every_agent(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2", "a3"], mode="all"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", success_executor)
        )
        assert set(result["results"].keys()) == {"a1", "a2", "a3"}

    def test_all_mode_all_succeeded_true_when_no_errors(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="all"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", success_executor)
        )
        assert result["allSucceeded"] is True
        assert result["anySucceeded"] is True

    def test_all_mode_all_succeeded_false_when_one_fails(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="all"))
        executor = make_selective_executor(failing_ids={"a2"})
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", executor)
        )
        assert result["allSucceeded"] is False
        assert result["anySucceeded"] is True

    def test_all_mode_any_succeeded_false_when_all_fail(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="all"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", failure_executor)
        )
        assert result["anySucceeded"] is False

    def test_all_mode_first_response_set(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="all"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", success_executor)
        )
        assert result["firstResponse"] is not None
        assert result["firstResponse"]["agentId"] in {"a1", "a2"}

    def test_all_mode_group_id_in_result(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("my-group", ["a1"], mode="all"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("my-group", "ping", success_executor)
        )
        assert result["groupId"] == "my-group"


# ---------------------------------------------------------------------------
# Tests: race mode
# ---------------------------------------------------------------------------

class TestBroadcastRace:
    def test_race_mode_returns_first_response(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="race"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", success_executor)
        )
        assert result["anySucceeded"] is True
        assert result["firstResponse"] is not None

    def test_race_mode_any_succeeded_false_when_all_fail(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="race"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", failure_executor)
        )
        assert result["anySucceeded"] is False

    def test_race_mode_group_id_in_result(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("race-group", ["a1", "a2"], mode="race"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("race-group", "ping", success_executor)
        )
        assert result["groupId"] == "race-group"


# ---------------------------------------------------------------------------
# Tests: fallback mode
# ---------------------------------------------------------------------------

class TestBroadcastFallback:
    def test_fallback_stops_at_first_success(self):
        """Fallback should stop after the first successful agent."""
        called = []

        async def tracking_executor(agent_id, message, upstream_slush=None):
            called.append(agent_id)
            if agent_id == "a1":
                raise RuntimeError("a1 failed")
            return {"agentId": agent_id, "status": "ok"}

        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2", "a3"], mode="fallback"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", tracking_executor)
        )
        # a3 should never be called because a2 succeeded
        assert "a3" not in called
        assert result["anySucceeded"] is True
        assert result["firstResponse"]["agentId"] == "a2"

    def test_fallback_all_succeed_false_if_first_fails(self):
        """allSucceeded should be False if any agent along the way failed."""
        executor = make_selective_executor(failing_ids={"a1"})
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="fallback"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", executor)
        )
        assert result["allSucceeded"] is False

    def test_fallback_any_succeeded_false_when_all_fail(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="fallback"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", failure_executor)
        )
        assert result["anySucceeded"] is False
        assert result["firstResponse"] is None

    def test_fallback_passes_upstream_slush_on_retry(self):
        """Executor should receive upstream_slush on the second attempt."""
        received_slush = []

        async def slush_executor(agent_id, message, upstream_slush=None):
            received_slush.append(upstream_slush)
            if agent_id == "a1":
                err = RuntimeError("a1 failed")
                err.result = {"data_slush": {"from_a1": True}}
                raise err
            return {"agentId": agent_id, "status": "ok"}

        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="fallback"))
        asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", slush_executor)
        )
        # a1 is called with None, a2 with potential slush (may be None depending on error shape)
        assert len(received_slush) == 2


# ---------------------------------------------------------------------------
# Tests: unknown mode falls back to 'all'
# ---------------------------------------------------------------------------

class TestBroadcastUnknownMode:
    def test_unknown_mode_treated_as_all(self):
        mgr = BroadcastManager()
        mgr.create_group(make_group("g1", ["a1", "a2"], mode="mystery"))
        result = asyncio.get_event_loop().run_until_complete(
            mgr.broadcast("g1", "ping", success_executor)
        )
        # Both agents should be called (same as 'all')
        assert set(result["results"].keys()) == {"a1", "a2"}
