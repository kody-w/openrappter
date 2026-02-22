"""Tests for PipelineAgent - declarative multi-agent pipeline runner."""

import json
import pytest

from openrappter.agents.pipeline_agent import PipelineAgent
from openrappter.agents.basic_agent import BasicAgent


# ---------------------------------------------------------------------------
# Helper agents
# ---------------------------------------------------------------------------

class EchoAgent(BasicAgent):
    """Returns whatever input was given; optionally emits data_slush."""

    def __init__(self, name="Echo", slush_value=None):
        self.name = name
        self._slush_value = slush_value
        metadata = {
            "name": name,
            "description": "Echoes input",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name=name, metadata=metadata)

    def perform(self, **kwargs):
        payload = {"status": "success", "agent": self.name}
        if self._slush_value is not None:
            payload["data_slush"] = self._slush_value
        return json.dumps(payload)


class FailingAgent(BasicAgent):
    def __init__(self):
        metadata = {
            "name": "Failing",
            "description": "Always fails",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="Failing", metadata=metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "error", "message": "intentional failure"})


def make_resolver(agents):
    """Build an agent resolver dict from a list of BasicAgent instances."""
    registry = {a.name: a for a in agents}
    return registry.get


# ---------------------------------------------------------------------------
# Helpers for building pipeline specs
# ---------------------------------------------------------------------------

def agent_step(step_id, agent_name, on_error="stop", extra_input=None):
    step = {"id": step_id, "type": "agent", "agent": agent_name, "onError": on_error}
    if extra_input:
        step["input"] = extra_input
    return step


def parallel_step(step_id, agent_names, on_error="stop"):
    return {"id": step_id, "type": "parallel", "agents": agent_names, "onError": on_error}


def conditional_step(step_id, agent_name, condition, on_error="stop"):
    return {
        "id": step_id,
        "type": "conditional",
        "agent": agent_name,
        "condition": condition,
        "onError": on_error,
    }


def loop_step(step_id, agent_name, max_iterations=3, condition=None):
    step = {
        "id": step_id,
        "type": "loop",
        "agent": agent_name,
        "maxIterations": max_iterations,
    }
    if condition:
        step["condition"] = condition
    return step


# ---------------------------------------------------------------------------
# Tests: constructor and metadata
# ---------------------------------------------------------------------------

class TestPipelineAgentInit:
    def test_name_is_pipeline(self):
        agent = PipelineAgent()
        assert agent.name == "Pipeline"

    def test_metadata_has_expected_actions(self):
        agent = PipelineAgent()
        actions = agent.metadata["parameters"]["properties"]["action"]["enum"]
        assert "run" in actions
        assert "validate" in actions
        assert "status" in actions

    def test_set_agent_resolver(self):
        agent = PipelineAgent()
        resolver = lambda name: None
        agent.set_agent_resolver(resolver)
        assert agent._agent_resolver is resolver


# ---------------------------------------------------------------------------
# Tests: no action specified
# ---------------------------------------------------------------------------

class TestNoAction:
    def test_no_action_returns_error(self):
        agent = PipelineAgent()
        result = json.loads(agent.perform())
        assert result["status"] == "error"
        assert "action" in result["message"].lower() or "action" in result["message"]

    def test_unknown_action_returns_error(self):
        agent = PipelineAgent()
        result = json.loads(agent.perform(action="fly"))
        assert result["status"] == "error"


# ---------------------------------------------------------------------------
# Tests: validate action
# ---------------------------------------------------------------------------

class TestValidateAction:
    def test_validate_valid_spec(self):
        agent = PipelineAgent()
        spec = {
            "name": "my-pipeline",
            "steps": [agent_step("s1", "Echo")],
        }
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["status"] == "success"
        assert result["valid"] is True

    def test_validate_missing_spec(self):
        agent = PipelineAgent()
        result = json.loads(agent.perform(action="validate"))
        assert result["status"] == "error"

    def test_validate_missing_name(self):
        agent = PipelineAgent()
        spec = {"steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False
        assert any("name" in e for e in result["errors"])

    def test_validate_missing_steps(self):
        agent = PipelineAgent()
        spec = {"name": "test"}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False

    def test_validate_step_missing_id(self):
        agent = PipelineAgent()
        spec = {"name": "test", "steps": [{"type": "agent", "agent": "Echo"}]}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False
        assert any("id" in e for e in result["errors"])

    def test_validate_step_missing_type(self):
        agent = PipelineAgent()
        spec = {"name": "test", "steps": [{"id": "s1", "agent": "Echo"}]}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False

    def test_validate_agent_step_missing_agent_name(self):
        agent = PipelineAgent()
        spec = {"name": "test", "steps": [{"id": "s1", "type": "agent"}]}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False

    def test_validate_parallel_step_missing_agents(self):
        agent = PipelineAgent()
        spec = {"name": "test", "steps": [{"id": "s1", "type": "parallel"}]}
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False

    def test_validate_reports_step_count(self):
        agent = PipelineAgent()
        spec = {
            "name": "test",
            "steps": [agent_step("s1", "A"), agent_step("s2", "B")],
        }
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["stepCount"] == 2

    def test_validate_uses_resolver_to_check_agents(self):
        resolver = make_resolver([EchoAgent("Echo")])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "test",
            "steps": [agent_step("s1", "DoesNotExist")],
        }
        result = json.loads(agent.perform(action="validate", spec=spec))
        assert result["valid"] is False
        assert any("not found" in e for e in result["errors"])


# ---------------------------------------------------------------------------
# Tests: status action
# ---------------------------------------------------------------------------

class TestStatusAction:
    def test_status_before_any_run(self):
        agent = PipelineAgent()
        result = json.loads(agent.perform(action="status"))
        assert result["status"] == "success"
        assert "No pipeline" in result["message"]

    def test_status_after_run_shows_last_result(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe1", "steps": [agent_step("s1", "Echo")]}
        agent.perform(action="run", spec=spec)
        result = json.loads(agent.perform(action="status"))
        assert result["status"] == "success"
        assert result["lastRun"]["pipelineName"] == "pipe1"


# ---------------------------------------------------------------------------
# Tests: run action – basic sequential execution
# ---------------------------------------------------------------------------

class TestRunAction:
    def test_run_requires_spec(self):
        agent = PipelineAgent()
        result = json.loads(agent.perform(action="run"))
        assert result["status"] == "error"

    def test_run_requires_agent_resolver(self):
        agent = PipelineAgent()
        spec = {"name": "p", "steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        assert result["status"] == "error"
        assert "resolver" in result["message"]

    def test_run_single_agent_step(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "simple", "steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        assert result["status"] == "success"
        assert result["pipeline"]["pipelineName"] == "simple"

    def test_run_records_step_results(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe", "steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        steps = result["pipeline"]["steps"]
        assert len(steps) == 1
        assert steps[0]["stepId"] == "s1"
        assert steps[0]["agentName"] == "Echo"

    def test_run_multiple_sequential_steps(self):
        a = EchoAgent("A")
        b = EchoAgent("B")
        resolver = make_resolver([a, b])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "two-step",
            "steps": [agent_step("s1", "A"), agent_step("s2", "B")],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        assert len(result["pipeline"]["steps"]) == 2

    def test_run_result_has_data_slush(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe", "steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        assert "data_slush" in result

    def test_run_result_has_total_latency(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe", "steps": [agent_step("s1", "Echo")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        assert "totalLatencyMs" in result["pipeline"]

    def test_run_missing_agent_fails_with_stop(self):
        resolver = make_resolver([])  # no agents registered
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe", "steps": [agent_step("s1", "Ghost", on_error="stop")]}
        result = json.loads(agent.perform(action="run", spec=spec))
        assert result["status"] == "error"


# ---------------------------------------------------------------------------
# Tests: data_slush threading between steps
# ---------------------------------------------------------------------------

class TestDataSlushFlow:
    def test_data_slush_forwarded_between_steps(self):
        """Step 1 emits data_slush; Step 2 receives it as upstream_slush in execute() context."""
        context_upstream_slushes = []

        class CapturingAgent(BasicAgent):
            def __init__(self):
                metadata = {
                    "name": "Capturing",
                    "description": "",
                    "parameters": {"type": "object", "properties": {}, "required": []},
                }
                super().__init__(name="Capturing", metadata=metadata)

            def perform(self, **kwargs):
                # upstream_slush is placed in self.context by execute() before perform() runs
                context_upstream_slushes.append(self.context.get("upstream_slush"))
                return json.dumps({"status": "success"})

        producer = EchoAgent("Producer", slush_value={"produced": True})
        consumer = CapturingAgent()
        resolver = make_resolver([producer, consumer])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "slush-pipe",
            "steps": [
                agent_step("s1", "Producer"),
                agent_step("s2", "Capturing"),
            ],
        }
        agent.perform(action="run", spec=spec)
        # s2 should have received slush from s1 in its context
        assert context_upstream_slushes[-1] == {"produced": True}

    def test_pipeline_slush_in_result_data_slush(self):
        producer = EchoAgent("Producer", slush_value={"key": "val"})
        resolver = make_resolver([producer])
        pipeline_agent = PipelineAgent(agent_resolver=resolver)
        spec = {"name": "pipe", "steps": [agent_step("s1", "Producer")]}
        result = json.loads(pipeline_agent.perform(action="run", spec=spec))
        assert "data_slush" in result
        slush = result["data_slush"]
        assert "pipeline_slush" in slush


# ---------------------------------------------------------------------------
# Tests: error handling
# ---------------------------------------------------------------------------

class ExceptionAgent(BasicAgent):
    """An agent that raises a Python exception (triggering the except branch)."""

    def __init__(self):
        metadata = {
            "name": "Exception",
            "description": "Raises an exception",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="Exception", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("exception from agent")


class TestErrorHandling:
    def test_stop_on_error_halts_pipeline(self):
        """An exception in a step with onError='stop' should halt the pipeline before s2."""
        exc_agent = ExceptionAgent()
        echo = EchoAgent("Echo")
        resolver = make_resolver([exc_agent, echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "err-pipe",
            "steps": [
                agent_step("s1", "Exception", on_error="stop"),
                agent_step("s2", "Echo"),
            ],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        # After a failed step with stop, the pipeline should not run s2
        steps = result["pipeline"]["steps"]
        step_ids = [s["stepId"] for s in steps]
        assert "s2" not in step_ids

    def test_continue_on_error_runs_remaining_steps(self):
        """An exception in a step with onError='continue' should allow s2 to run."""
        exc_agent = ExceptionAgent()
        echo = EchoAgent("Echo")
        resolver = make_resolver([exc_agent, echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "cont-pipe",
            "steps": [
                agent_step("s1", "Exception", on_error="continue"),
                agent_step("s2", "Echo"),
            ],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        steps = result["pipeline"]["steps"]
        step_ids = [s["stepId"] for s in steps]
        assert "s2" in step_ids

    def test_pipeline_status_partial_when_step_continues_after_error(self):
        """Pipeline status should be 'partial' when a step fails but execution continues."""
        exc_agent = ExceptionAgent()
        echo = EchoAgent("Echo")
        resolver = make_resolver([exc_agent, echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "cont-pipe",
            "steps": [
                agent_step("s1", "Exception", on_error="continue"),
                agent_step("s2", "Echo"),
            ],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        assert result["pipeline"]["status"] == "partial"

    def test_pipeline_status_failed_when_stop_on_error(self):
        """Pipeline status should be 'failed' when a step raises and onError='stop'."""
        exc_agent = ExceptionAgent()
        resolver = make_resolver([exc_agent])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "fail-pipe",
            "steps": [agent_step("s1", "Exception", on_error="stop")],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        assert result["pipeline"]["status"] == "failed"


# ---------------------------------------------------------------------------
# Tests: parallel step
# ---------------------------------------------------------------------------

class TestParallelStep:
    def test_parallel_step_runs_all_agents(self):
        a = EchoAgent("A")
        b = EchoAgent("B")
        resolver = make_resolver([a, b])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "par-pipe",
            "steps": [parallel_step("s1", ["A", "B"])],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        steps = result["pipeline"]["steps"]
        agent_names = {s["agentName"] for s in steps}
        assert "A" in agent_names
        assert "B" in agent_names


# ---------------------------------------------------------------------------
# Tests: conditional step
# ---------------------------------------------------------------------------

class TestConditionalStep:
    def test_conditional_step_skips_when_condition_not_met(self):
        echo = EchoAgent("Echo")
        resolver = make_resolver([echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "cond-pipe",
            "steps": [
                conditional_step(
                    "s1", "Echo",
                    condition={"field": "missing_field", "exists": True},
                ),
            ],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        steps = result["pipeline"]["steps"]
        assert steps[0]["status"] == "skipped"

    def test_conditional_step_runs_when_condition_met(self):
        producer = EchoAgent("Producer", slush_value={"ready": True})
        echo = EchoAgent("Echo")
        resolver = make_resolver([producer, echo])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "cond-pipe",
            "steps": [
                agent_step("s1", "Producer"),
                conditional_step(
                    "s2", "Echo",
                    condition={"field": "ready", "equals": True},
                ),
            ],
        }
        result = json.loads(agent.perform(action="run", spec=spec))
        steps = result["pipeline"]["steps"]
        executed = [s for s in steps if s["stepId"] == "s2"]
        assert executed[0]["status"] == "success"


# ---------------------------------------------------------------------------
# Tests: loop step
# ---------------------------------------------------------------------------

class TestLoopStep:
    def test_loop_step_runs_max_iterations_times(self):
        call_count = [0]

        class CountingAgent(BasicAgent):
            def __init__(self):
                metadata = {
                    "name": "Counter",
                    "description": "",
                    "parameters": {"type": "object", "properties": {}, "required": []},
                }
                super().__init__(name="Counter", metadata=metadata)

            def perform(self, **kwargs):
                call_count[0] += 1
                return json.dumps({"status": "success", "count": call_count[0]})

        counter = CountingAgent()
        resolver = make_resolver([counter])
        agent = PipelineAgent(agent_resolver=resolver)
        spec = {
            "name": "loop-pipe",
            "steps": [loop_step("s1", "Counter", max_iterations=3)],
        }
        agent.perform(action="run", spec=spec)
        assert call_count[0] == 3
