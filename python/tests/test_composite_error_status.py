"""Composite error-status parity tests.

A sub-agent that *returns* a structured ``{"status": "error"}`` envelope has
failed just as surely as one that raises. These tests pin that contract for the
composition layers (AgentGraph, BroadcastManager, AgentChain, PipelineAgent,
SubAgentManager) and pin the shared classifier and failure-reason extractor
against the cross-runtime vector file in ``contracts/``.

Mirrors typescript/src/__tests__/parity/composite-error-status.test.ts
"""

import asyncio
import json
from pathlib import Path

import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.broadcast import BroadcastManager
from openrappter.agents.chain import AgentChain
from openrappter.agents.graph import AgentGraph
from openrappter.agents.pipeline_agent import PipelineAgent
from openrappter.agents.subagent import SubAgentManager
from openrappter.result_status import agent_result_error_message, agent_result_is_error


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


class TrackingAgent(BasicAgent):
    """Records that it ran, so "never reached" can be asserted directly."""

    def __init__(self, name, log):
        self.name = name
        self.metadata = _meta(name, "records that it ran")
        self._log = log
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        self._log.append(self.name)
        return json.dumps({"status": "success"})


class ShoutFailAgent(BasicAgent):
    """Reports failure with an uppercase status, which the classifier folds."""

    def __init__(self, name="ShoutFail"):
        self.name = name
        self.metadata = _meta(name, "returns an uppercase error envelope")
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "ERROR", "message": "loud failure"})


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
_CONTRACT = json.loads(VECTOR_PATH.read_text())
VECTORS = _CONTRACT["vectors"]
MESSAGE_VECTORS = _CONTRACT["messageVectors"]
FALLBACK_MESSAGE = "agent returned an error envelope"


def test_vector_file_is_loaded():
    assert len(VECTORS) > 20


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_classifier_matches_cross_runtime_vectors(vector):
    assert agent_result_is_error(vector["value"]) is vector["isError"]


def test_message_vector_file_is_loaded():
    assert len(MESSAGE_VECTORS) > 5


@pytest.mark.parametrize("vector", MESSAGE_VECTORS, ids=[v["name"] for v in MESSAGE_VECTORS])
def test_error_message_matches_cross_runtime_vectors(vector):
    expected = vector["message"] if vector["message"] is not None else FALLBACK_MESSAGE
    assert agent_result_error_message(vector["value"]) == expected


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


# ---------------------------------------------------------------------------
# AgentChain
# ---------------------------------------------------------------------------

class TestChainErrorEnvelope:
    def test_stop_on_error_halts_on_error_envelope(self):
        ran = []
        chain = AgentChain()
        chain.add_step("good", OkAgent())
        chain.add_step("bad", SoftFailAgent())
        chain.add_step("after", TrackingAgent("After", ran))

        result = chain.run()

        assert result.status == "error"
        assert result.failed_step == "bad"
        assert result.error == "exit code 1"
        assert [s.name for s in result.steps] == ["good", "bad"]
        assert ran == []

    def test_failed_step_envelope_is_preserved(self):
        chain = AgentChain()
        chain.add_step("bad", SoftFailAgent())

        result = chain.run()

        assert result.final_result["status"] == "error"
        assert result.final_result["message"] == "exit code 1"
        assert result.steps[0].result["message"] == "exit code 1"

    def test_raise_and_error_envelope_are_identical(self):
        soft_ran, hard_ran = [], []
        soft = AgentChain()
        soft.add_step("bad", SoftFailAgent())
        soft.add_step("after", TrackingAgent("SoftAfter", soft_ran))
        hard = AgentChain()
        hard.add_step("bad", RaiseAgent())
        hard.add_step("after", TrackingAgent("HardAfter", hard_ran))

        soft_result, hard_result = soft.run(), hard.run()

        assert soft_result.status == hard_result.status
        assert soft_result.failed_step == hard_result.failed_step
        assert len(soft_result.steps) == len(hard_result.steps)
        assert soft_ran == hard_ran == []

    def test_continues_when_stop_on_error_is_false(self):
        ran = []
        chain = AgentChain({"stop_on_error": False})
        chain.add_step("bad", SoftFailAgent())
        chain.add_step("after", TrackingAgent("After", ran))

        result = chain.run()

        assert result.status == "partial"
        assert ran == ["After"]
        assert result.failed_step is None

    def test_uppercase_error_envelope_rolls_up_as_failure(self):
        stopping = AgentChain()
        stopping.add_step("bad", ShoutFailAgent())
        continuing = AgentChain({"stop_on_error": False})
        continuing.add_step("bad", ShoutFailAgent())

        stopped, continued = stopping.run(), continuing.run()

        assert stopped.status == "error"
        assert stopped.error == "loud failure"
        assert continued.status == "partial"

    def test_failed_step_slush_reaches_the_rollup(self):
        chain = AgentChain()
        chain.add_step("bad", SoftFailAgent())

        assert chain.run().final_slush == {"failed_by": "SoftFail"}

    def test_all_success_chain_still_succeeds(self):
        chain = AgentChain()
        chain.add_step("a", OkAgent("A"))
        chain.add_step("b", OkAgent("B"))

        result = chain.run()

        assert result.status == "success"
        assert len(result.steps) == 2


# ---------------------------------------------------------------------------
# PipelineAgent
# ---------------------------------------------------------------------------

def run_pipeline(agents, steps):
    pipeline = PipelineAgent(lambda name: agents.get(name))
    return json.loads(
        pipeline.execute(action="run", spec={"name": "p", "input": {}, "steps": steps})
    )


class TestPipelineErrorEnvelope:
    def test_agent_step_returning_error_envelope_is_errored(self):
        out = run_pipeline(
            {"Bad": SoftFailAgent("Bad")},
            [{"id": "s1", "type": "agent", "agent": "Bad"}],
        )

        assert out["pipeline"]["steps"][0]["status"] == "error"
        assert out["pipeline"]["status"] == "failed"
        assert out["status"] == "error"

    def test_on_error_stop_halts_the_pipeline(self):
        ran = []
        out = run_pipeline(
            {"Bad": SoftFailAgent("Bad"), "After": TrackingAgent("After", ran)},
            [
                {"id": "s1", "type": "agent", "agent": "Bad", "onError": "stop"},
                {"id": "s2", "type": "agent", "agent": "After"},
            ],
        )

        assert [s["stepId"] for s in out["pipeline"]["steps"]] == ["s1"]
        assert ran == []

    def test_on_error_continue_keeps_going_but_reports_partial(self):
        ran = []
        out = run_pipeline(
            {"Bad": SoftFailAgent("Bad"), "After": TrackingAgent("After", ran)},
            [
                {"id": "s1", "type": "agent", "agent": "Bad", "onError": "continue"},
                {"id": "s2", "type": "agent", "agent": "After"},
            ],
        )

        assert out["pipeline"]["status"] == "partial"
        assert ran == ["After"]

    def test_raise_and_error_envelope_are_identical(self):
        soft_ran, hard_ran = [], []
        soft = run_pipeline(
            {"Bad": SoftFailAgent("Bad"), "After": TrackingAgent("SoftAfter", soft_ran)},
            [
                {"id": "s1", "type": "agent", "agent": "Bad", "onError": "stop"},
                {"id": "s2", "type": "agent", "agent": "After"},
            ],
        )
        hard = run_pipeline(
            {"Bad": RaiseAgent("Bad"), "After": TrackingAgent("HardAfter", hard_ran)},
            [
                {"id": "s1", "type": "agent", "agent": "Bad", "onError": "stop"},
                {"id": "s2", "type": "agent", "agent": "After"},
            ],
        )

        assert soft["pipeline"]["status"] == hard["pipeline"]["status"]
        assert soft["status"] == hard["status"]
        assert len(soft["pipeline"]["steps"]) == len(hard["pipeline"]["steps"])
        assert soft_ran == hard_ran == []

    def test_parallel_branch_error_fails_the_step_and_keeps_payloads(self):
        out = run_pipeline(
            {"A": OkAgent("A"), "B": SoftFailAgent("B")},
            [{"id": "fan", "type": "parallel", "agents": ["A", "B"], "onError": "continue"}],
        )

        by_agent = {s["agentName"]: s["status"] for s in out["pipeline"]["steps"]}
        assert by_agent == {"A": "success", "B": "error"}
        assert out["pipeline"]["status"] == "partial"

    def test_conditional_body_error_is_reported(self):
        out = run_pipeline(
            {"Ok": OkAgent("Ok"), "Bad": SoftFailAgent("Bad")},
            [
                {"id": "s1", "type": "agent", "agent": "Ok"},
                {
                    "id": "s2",
                    "type": "conditional",
                    "agent": "Bad",
                    "condition": {"field": "from", "equals": "Ok"},
                    "onError": "continue",
                },
            ],
        )

        assert out["pipeline"]["steps"][1]["status"] == "error"
        assert out["pipeline"]["status"] == "partial"

    def test_loop_iteration_error_ends_the_loop(self):
        out = run_pipeline(
            {"Bad": SoftFailAgent("Bad")},
            [
                {
                    "id": "loop",
                    "type": "loop",
                    "agent": "Bad",
                    "maxIterations": 4,
                    "onError": "continue",
                }
            ],
        )

        assert len(out["pipeline"]["steps"]) == 1
        assert out["pipeline"]["steps"][0]["status"] == "error"

    def test_all_success_pipeline_still_completes(self):
        out = run_pipeline(
            {"A": OkAgent("A"), "B": OkAgent("B")},
            [
                {"id": "s1", "type": "agent", "agent": "A"},
                {"id": "s2", "type": "agent", "agent": "B"},
            ],
        )

        assert out["pipeline"]["status"] == "completed"
        assert out["status"] == "success"
        assert all(s["status"] == "success" for s in out["pipeline"]["steps"])


# ---------------------------------------------------------------------------
# SubAgentManager
# ---------------------------------------------------------------------------

def manager_for(agents):
    mgr = SubAgentManager()

    async def executor(agent_id, message, context=None, upstream_slush=None):
        return json.loads(agents[agent_id].execute(query=message))

    mgr.set_executor(executor)
    return mgr


class TestSubAgentErrorEnvelope:
    def test_call_returning_error_envelope_is_recorded_as_errored(self):
        mgr = manager_for({"bad": SoftFailAgent()})
        asyncio.run(mgr.invoke("bad", "go", mgr.create_context("root")))

        call = mgr.get_call_history()[-1]
        assert call["status"] == "error"
        assert call["error"] == "exit code 1"

    def test_envelope_is_still_returned_to_the_caller(self):
        mgr = manager_for({"bad": SoftFailAgent()})
        result = asyncio.run(mgr.invoke("bad", "go", mgr.create_context("root")))

        assert result["status"] == "error"
        assert result["message"] == "exit code 1"
        assert mgr.get_call_history()[-1]["result"] == result

    def test_raise_and_error_envelope_record_the_same_status(self):
        soft = manager_for({"bad": SoftFailAgent()})
        asyncio.run(soft.invoke("bad", "go", soft.create_context("root")))

        hard = SubAgentManager()

        async def raising(agent_id, message, context=None, upstream_slush=None):
            raise RuntimeError("hard failure")

        hard.set_executor(raising)
        with pytest.raises(RuntimeError, match="hard failure"):
            asyncio.run(hard.invoke("bad", "go", hard.create_context("root")))

        assert soft.get_call_history()[-1]["status"] == hard.get_call_history()[-1]["status"]

    def test_call_is_cleared_from_active_calls(self):
        mgr = manager_for({"bad": SoftFailAgent()})
        asyncio.run(mgr.invoke("bad", "go", mgr.create_context("root")))

        assert mgr.get_active_calls() == []
        assert len(mgr.get_call_history()) == 1

    def test_failed_subagent_slush_is_still_forwarded(self):
        mgr = manager_for({"bad": SoftFailAgent()})
        ctx = mgr.create_context("root")
        asyncio.run(mgr.invoke("bad", "go", ctx))

        assert ctx["lastSlush"] == {"failed_by": "SoftFail"}

    def test_successful_call_is_recorded_as_success(self):
        mgr = manager_for({"ok": OkAgent()})
        asyncio.run(mgr.invoke("ok", "go", mgr.create_context("root")))

        call = mgr.get_call_history()[-1]
        assert call["status"] == "success"
        assert "error" not in call
