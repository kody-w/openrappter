"""Composite error-status parity tests.

A sub-agent that *returns* a structured ``{"status": "error"}`` envelope has
failed just as surely as one that raises. These tests pin that contract for the
composition layers (AgentGraph, BroadcastManager) and pin the shared classifier
against the cross-runtime vector file in ``contracts/``.

Mirrors typescript/src/__tests__/parity/composite-error-status.test.ts
"""

import asyncio
import json
from pathlib import Path

import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.broadcast import BroadcastManager
from openrappter.agents.graph import AgentGraph
from openrappter.result_status import agent_result_is_error


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _meta(name, description):
    return {
        "name": name,
        "description": description,
        "parameters": {"type": "object", "properties": {}, "required": []},
    }


class OkAgent(BasicAgent):
    def __init__(self, name="Ok"):
        self.name = name
        self.metadata = _meta(name, "returns a success envelope")
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "ok": True, "data_slush": {"from": self.name}})


class SoftFailAgent(BasicAgent):
    """Reports failure the structured way: returns, never raises."""

    def __init__(self, name="SoftFail"):
        self.name = name
        self.metadata = _meta(name, "returns a resolved error envelope")
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({
            "status": "error",
            "message": "exit code 1",
            "data_slush": {"failed_by": self.name},
        })


class RaiseAgent(BasicAgent):
    def __init__(self, name="Raise"):
        self.name = name
        self.metadata = _meta(name, "raises")
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        raise RuntimeError("hard failure")


class SlowOkAgent(BasicAgent):
    def __init__(self, name="SlowOk", delay_s=0.05):
        self.name = name
        self.metadata = _meta(name, "succeeds slowly")
        self._delay_s = delay_s
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "slow": True})


def as_executor(agents, delays=None):
    delays = delays or {}

    async def executor(agent_id, message, upstream_slush=None):
        if agent_id in delays:
            await asyncio.sleep(delays[agent_id])
        return json.loads(agents[agent_id].execute(query=message))

    return executor


def make_group(group_id, agent_ids, mode):
    return {"id": group_id, "name": group_id, "agentIds": agent_ids, "mode": mode}


# ---------------------------------------------------------------------------
# Shared classifier vectors
# ---------------------------------------------------------------------------

VECTOR_PATH = Path(__file__).parents[2] / "contracts" / "agent-result-status-vectors.json"
VECTORS = json.loads(VECTOR_PATH.read_text())["vectors"]


def test_vector_file_is_loaded():
    assert len(VECTORS) > 20


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_classifier_matches_cross_runtime_vectors(vector):
    assert agent_result_is_error(vector["value"]) is vector["isError"]


# ---------------------------------------------------------------------------
# AgentGraph
# ---------------------------------------------------------------------------

class TestGraphErrorEnvelope:
    def test_node_returning_error_envelope_is_errored(self):
        graph = AgentGraph()
        graph.add_node(name="root", agent=SoftFailAgent())
        result = graph.run()

        assert result.nodes["root"].status == "error"
        assert result.status == "partial"

    def test_dependents_are_skipped(self):
        graph = AgentGraph()
        graph.add_node(name="root", agent=SoftFailAgent())
        graph.add_node(name="child", agent=OkAgent(), depends_on=["root"])
        graph.add_node(name="grandchild", agent=OkAgent("Ok2"), depends_on=["child"])
        result = graph.run()

        assert result.nodes["child"].status == "skipped"
        assert result.nodes["grandchild"].status == "skipped"
        assert result.status == "partial"

    def test_stop_on_error_halts_the_graph(self):
        graph = AgentGraph({"stop_on_error": True})
        graph.add_node(name="root", agent=SoftFailAgent())
        graph.add_node(name="child", agent=OkAgent(), depends_on=["root"])
        result = graph.run()

        assert result.status == "error"
        assert result.error == "exit code 1"
        assert result.nodes["child"].status == "skipped"

    def test_error_envelope_is_preserved_on_the_node(self):
        graph = AgentGraph()
        graph.add_node(name="root", agent=SoftFailAgent())
        result = graph.run()

        assert result.nodes["root"].result["status"] == "error"
        assert result.nodes["root"].result["message"] == "exit code 1"

    def test_raise_and_error_envelope_are_equivalent(self):
        soft = AgentGraph()
        soft.add_node(name="a", agent=SoftFailAgent())
        soft.add_node(name="b", agent=OkAgent(), depends_on=["a"])
        soft_result = soft.run()

        hard = AgentGraph()
        hard.add_node(name="a", agent=RaiseAgent())
        hard.add_node(name="b", agent=OkAgent(), depends_on=["a"])
        hard_result = hard.run()

        assert soft_result.status == hard_result.status
        assert soft_result.nodes["a"].status == hard_result.nodes["a"].status
        assert soft_result.nodes["b"].status == hard_result.nodes["b"].status

    def test_all_success_still_reports_success(self):
        graph = AgentGraph()
        graph.add_node(name="root", agent=OkAgent())
        graph.add_node(name="child", agent=OkAgent("Ok2"), depends_on=["root"])
        result = graph.run()

        assert result.status == "success"
        assert result.nodes["child"].status == "success"

    def test_parallel_level_marks_error_envelope_nodes(self):
        """Exercises the ThreadPoolExecutor branch (>1 runnable node in a level)."""
        graph = AgentGraph()
        graph.add_node(name="a", agent=SoftFailAgent("A"))
        graph.add_node(name="b", agent=OkAgent("B"))
        graph.add_node(name="c", agent=OkAgent("C"), depends_on=["a"])
        result = graph.run()

        assert result.nodes["a"].status == "error"
        assert result.nodes["b"].status == "success"
        assert result.nodes["c"].status == "skipped"
        assert result.status == "partial"


# ---------------------------------------------------------------------------
# BroadcastManager
# ---------------------------------------------------------------------------

class TestBroadcastErrorEnvelope:
    def test_all_mode_clears_all_succeeded(self):
        agents = {"ok": OkAgent(), "bad": SoftFailAgent()}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["ok", "bad"], "all"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["allSucceeded"] is False
        assert result["anySucceeded"] is True

    def test_all_mode_keeps_the_full_error_envelope(self):
        agents = {"ok": OkAgent(), "bad": SoftFailAgent()}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["ok", "bad"], "all"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))
        bad = result["results"]["bad"]

        assert not isinstance(bad, Exception)
        assert bad["status"] == "error"
        assert bad["message"] == "exit code 1"
        assert "ok" in result["results"]

    def test_all_mode_total_failure(self):
        agents = {"a": SoftFailAgent("A"), "b": SoftFailAgent("B")}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["a", "b"], "all"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["anySucceeded"] is False
        assert result["allSucceeded"] is False
        assert result["firstResponse"] is None

    def test_all_mode_first_response_skips_errored_branch(self):
        agents = {"bad": SoftFailAgent(), "ok": OkAgent()}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["bad", "ok"], "all"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["firstResponse"]["agentId"] == "ok"

    def test_fallback_falls_through_to_next_agent(self):
        agents = {"bad": SoftFailAgent(), "ok": OkAgent()}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["bad", "ok"], "fallback"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert list(result["results"].keys()) == ["bad", "ok"]
        assert result["firstResponse"]["agentId"] == "ok"
        assert result["anySucceeded"] is True

    def test_fallback_forwards_data_slush_from_soft_failure(self):
        seen = []

        async def executor(agent_id, message, upstream_slush=None):
            seen.append(upstream_slush)
            if agent_id == "bad":
                return {"status": "error", "message": "nope", "data_slush": {"tried": "bad"}}
            return {"status": "success"}

        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["bad", "ok"], "fallback"))
        asyncio.run(mgr.broadcast("g", "ping", executor))

        assert seen[0] is None
        assert seen[1] == {"tried": "bad"}

    def test_fallback_total_failure(self):
        agents = {"a": SoftFailAgent("A"), "b": SoftFailAgent("B")}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["a", "b"], "fallback"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["anySucceeded"] is False
        assert result["firstResponse"] is None

    def test_race_error_envelope_does_not_win(self):
        agents = {"bad": SoftFailAgent(), "slow": SlowOkAgent()}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["bad", "slow"], "race"))

        result = asyncio.run(
            mgr.broadcast("g", "ping", as_executor(agents, delays={"slow": 0.05}))
        )

        assert result["firstResponse"]["agentId"] == "slow"
        assert result["anySucceeded"] is True
        assert result["allSucceeded"] is False

    def test_race_no_winner_when_all_error(self):
        agents = {"a": SoftFailAgent("A"), "b": SoftFailAgent("B")}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["a", "b"], "race"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["firstResponse"] is None
        assert result["anySucceeded"] is False

    def test_all_success_broadcast_still_succeeds(self):
        agents = {"a": OkAgent("A"), "b": OkAgent("B")}
        mgr = BroadcastManager()
        mgr.create_group(make_group("g", ["a", "b"], "all"))

        result = asyncio.run(mgr.broadcast("g", "ping", as_executor(agents)))

        assert result["allSucceeded"] is True
        assert result["anySucceeded"] is True
