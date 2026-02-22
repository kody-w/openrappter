"""Tests for Showcase: Agent Compiler - PipelineAgent conditional steps."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.pipeline_agent import PipelineAgent


class InputParserAgent(BasicAgent):
    def __init__(self, needs_new=True):
        self._needs_new = needs_new
        metadata = {"name": "InputParser", "description": "Parses input", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="InputParser", metadata=metadata)

    def perform(self, **kwargs):
        input_text = kwargs.get("input", "")
        return json.dumps({
            "status": "success",
            "parsed": input_text,
            "needs_new_agent": self._needs_new,
            "agent_description": f"agent that processes: {input_text}" if self._needs_new else None,
            "data_slush": {"needs_new_agent": self._needs_new, "agent_description": f"agent that processes: {input_text}" if self._needs_new else None},
        })


class AgentCreatorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "AgentCreator", "description": "Creates agents", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="AgentCreator", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush", {})
        description = upstream.get("agent_description", "generic agent") if upstream else "generic agent"
        return json.dumps({
            "status": "success",
            "created": True,
            "agent_name": "DynamicProcessor",
            "agent_description": description,
            "data_slush": {"created": True, "agent_name": "DynamicProcessor", "agent_description": description},
        })


class DynamicExecutorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "DynamicExecutor", "description": "Executes dynamic agent", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="DynamicExecutor", metadata=metadata)

    def perform(self, **kwargs):
        upstream = self.context.get("upstream_slush", {})
        agent_name = upstream.get("agent_name", "unknown") if upstream else "unknown"
        return json.dumps({
            "status": "success",
            "executed": True,
            "agent_used": agent_name,
            "data_slush": {"executed": True, "agent_used": agent_name},
        })


def make_resolver(needs_new):
    agents = {"InputParser": InputParserAgent(needs_new), "AgentCreator": AgentCreatorAgent(), "DynamicExecutor": DynamicExecutorAgent()}
    return agents.get


class TestConditionalStepFires:
    def test_run_creator_when_needs_new_agent_true(self):
        pipeline = PipelineAgent(make_resolver(True))
        result_str = pipeline.execute(action="run", spec={
            "name": "agent-compiler",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "sentiment analysis"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "needs_new_agent", "equals": True}},
                {"id": "execute", "type": "agent", "agent": "DynamicExecutor"},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert result["status"] == "success"
        assert result["pipeline"]["status"] == "completed"
        steps = result["pipeline"]["steps"]
        assert len(steps) == 3
        assert steps[0]["agentName"] == "InputParser"
        assert steps[0]["status"] == "success"
        assert steps[1]["agentName"] == "AgentCreator"
        assert steps[1]["status"] == "success"
        assert steps[2]["agentName"] == "DynamicExecutor"
        assert steps[2]["status"] == "success"


class TestConditionalStepSkips:
    def test_skip_creator_when_needs_new_agent_false(self):
        pipeline = PipelineAgent(make_resolver(False))
        result_str = pipeline.execute(action="run", spec={
            "name": "agent-compiler",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "just run existing"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "needs_new_agent", "equals": True}},
                {"id": "execute", "type": "agent", "agent": "DynamicExecutor"},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert result["status"] == "success"
        steps = result["pipeline"]["steps"]
        assert len(steps) == 3
        assert steps[0]["status"] == "success"
        assert steps[1]["status"] == "skipped"
        assert steps[2]["status"] == "success"


class TestPipelineValidation:
    def test_validate_pipeline_spec(self):
        pipeline = PipelineAgent(make_resolver(True))
        result_str = pipeline.execute(action="validate", spec={
            "name": "agent-compiler",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser"},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "needs_new_agent", "equals": True}},
                {"id": "execute", "type": "agent", "agent": "DynamicExecutor"},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert result["valid"] is True
        assert result["stepCount"] == 3


class TestDataSlushFlow:
    def test_thread_data_slush_through_conditional(self):
        pipeline = PipelineAgent(make_resolver(True))
        result_str = pipeline.execute(action="run", spec={
            "name": "agent-compiler",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "image classifier"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "needs_new_agent", "equals": True}},
                {"id": "execute", "type": "agent", "agent": "DynamicExecutor"},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert "data_slush" in result
        assert result["data_slush"]["signals"]["pipeline_name"] == "agent-compiler"
        assert result["data_slush"]["signals"]["step_count"] == 3


class TestConditionalExists:
    def test_fire_when_field_exists(self):
        pipeline = PipelineAgent(make_resolver(True))
        result_str = pipeline.execute(action="run", spec={
            "name": "exists-check",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "test"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "agent_description", "exists": True}},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert result["pipeline"]["steps"][1]["status"] == "success"

    def test_field_with_null_value_exists(self):
        pipeline = PipelineAgent(make_resolver(False))
        result_str = pipeline.execute(action="run", spec={
            "name": "exists-check",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "test"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "agent_description", "exists": True}},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        # When needs_new=False, agent_description is None in the slush;
        # exists: True evaluates (value is not None) so None means the field is considered absent -> skipped
        assert result["pipeline"]["steps"][1]["status"] == "skipped"


class TestErrorHandlingInPipeline:
    def test_report_missing_spec(self):
        pipeline = PipelineAgent()
        result_str = pipeline.execute(action="run")
        result = json.loads(result_str)
        assert result["status"] == "error"
        assert "spec" in result["message"].lower() or "spec" in result["message"]

    def test_report_missing_action(self):
        pipeline = PipelineAgent()
        result_str = pipeline.execute()
        result = json.loads(result_str)
        assert result["status"] == "error"
        assert "action" in result["message"].lower() or "action" in result["message"]


class TestEndToEnd:
    def test_complete_full_pipeline(self):
        pipeline = PipelineAgent(make_resolver(True))
        result_str = pipeline.execute(action="run", spec={
            "name": "full-compiler",
            "steps": [
                {"id": "parse", "type": "agent", "agent": "InputParser", "input": {"input": "weather forecast agent"}},
                {"id": "create", "type": "conditional", "agent": "AgentCreator", "condition": {"field": "needs_new_agent", "equals": True}},
                {"id": "execute", "type": "agent", "agent": "DynamicExecutor"},
            ],
            "input": {},
        })
        result = json.loads(result_str)
        assert result["status"] == "success"
        assert result["pipeline"]["status"] == "completed"
        assert all(s["status"] == "success" for s in result["pipeline"]["steps"])
        assert result["pipeline"]["totalLatencyMs"] >= 0
