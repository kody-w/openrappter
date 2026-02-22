"""Tests for AgentChain - sequential agent pipeline with data_slush forwarding."""

import json
import time
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.chain import AgentChain, create_agent_chain


# ---------------------------------------------------------------------------
# Helper agents
# ---------------------------------------------------------------------------

class EchoAgent(BasicAgent):
    """Returns a success result with optional data_slush."""

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
    """Always raises an exception."""

    def __init__(self):
        metadata = {
            "name": "Failing",
            "description": "Always fails",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="Failing", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("intentional failure")


class CapturingAgent(BasicAgent):
    """Captures upstream_slush from context for assertions."""

    def __init__(self):
        self.captured_upstream = None
        metadata = {
            "name": "Capturing",
            "description": "Captures context",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__(name="Capturing", metadata=metadata)

    def perform(self, **kwargs):
        self.captured_upstream = self.context.get("upstream_slush")
        return json.dumps({"status": "success"})


# ---------------------------------------------------------------------------
# Tests: constructor and factory
# ---------------------------------------------------------------------------

class TestAgentChainInit:
    def test_empty_chain_has_zero_length(self):
        chain = AgentChain()
        assert chain.length == 0

    def test_factory_creates_instance(self):
        chain = create_agent_chain()
        assert isinstance(chain, AgentChain)

    def test_factory_passes_options(self):
        chain = create_agent_chain({'stop_on_error': False})
        assert chain._stop_on_error is False


# ---------------------------------------------------------------------------
# Tests: add_step and fluent chaining
# ---------------------------------------------------------------------------

class TestAddStep:
    def test_add_step_returns_self(self):
        chain = AgentChain()
        result = chain.add_step("s1", EchoAgent())
        assert result is chain

    def test_add_step_increments_length(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent())
        chain.add_step("s2", EchoAgent("B"))
        assert chain.length == 2

    def test_get_step_names(self):
        chain = AgentChain()
        chain.add_step("first", EchoAgent()).add_step("second", EchoAgent("B"))
        assert chain.get_step_names() == ["first", "second"]


# ---------------------------------------------------------------------------
# Tests: single step execution
# ---------------------------------------------------------------------------

class TestSingleStep:
    def test_single_step_success(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent())
        result = chain.run()
        assert result.status == "success"
        assert len(result.steps) == 1
        assert result.steps[0].name == "s1"

    def test_single_step_has_duration(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent())
        result = chain.run()
        assert result.steps[0].duration_ms >= 0
        assert result.total_duration_ms >= 0

    def test_single_step_final_result(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent())
        result = chain.run()
        assert result.final_result is not None
        assert result.final_result["status"] == "success"


# ---------------------------------------------------------------------------
# Tests: multi-step with data_slush forwarding
# ---------------------------------------------------------------------------

class TestMultiStep:
    def test_multi_step_all_execute(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent("A"))
        chain.add_step("s2", EchoAgent("B"))
        chain.add_step("s3", EchoAgent("C"))
        result = chain.run()
        assert result.status == "success"
        assert len(result.steps) == 3

    def test_data_slush_forwarded_between_steps(self):
        """Step 1 emits data_slush; Step 2 receives it as upstream_slush."""
        producer = EchoAgent("Producer", slush_value={"produced": True})
        consumer = CapturingAgent()
        chain = AgentChain()
        chain.add_step("s1", producer)
        chain.add_step("s2", consumer)
        chain.run()
        assert consumer.captured_upstream == {"produced": True}

    def test_final_slush_is_last_steps_slush(self):
        chain = AgentChain()
        chain.add_step("s1", EchoAgent("A", slush_value={"step": 1}))
        chain.add_step("s2", EchoAgent("B", slush_value={"step": 2}))
        result = chain.run()
        assert result.final_slush == {"step": 2}


# ---------------------------------------------------------------------------
# Tests: transform function
# ---------------------------------------------------------------------------

class TestTransform:
    def test_transform_applied_between_steps(self):
        captured_kwargs = {}

        class KwargsCapture(BasicAgent):
            def __init__(self):
                metadata = {"name": "Capture", "description": "", "parameters": {"type": "object", "properties": {}, "required": []}}
                super().__init__(name="Capture", metadata=metadata)

            def perform(self, **kwargs):
                captured_kwargs.update(kwargs)
                return json.dumps({"status": "success"})

        def my_transform(prev_result, slush):
            return {"extracted": prev_result.get("agent", "unknown")}

        chain = AgentChain()
        chain.add_step("s1", EchoAgent("Source"))
        chain.add_step("s2", KwargsCapture(), transform=my_transform)
        chain.run()
        assert captured_kwargs.get("extracted") == "Source"


# ---------------------------------------------------------------------------
# Tests: initial kwargs
# ---------------------------------------------------------------------------

class TestInitialKwargs:
    def test_initial_kwargs_merged_into_first_step(self):
        captured = {}

        class KwargsCapture(BasicAgent):
            def __init__(self):
                metadata = {"name": "Capture", "description": "", "parameters": {"type": "object", "properties": {}, "required": []}}
                super().__init__(name="Capture", metadata=metadata)

            def perform(self, **kwargs):
                captured.update(kwargs)
                return json.dumps({"status": "success"})

        chain = AgentChain()
        chain.add_step("s1", KwargsCapture())
        chain.run(initial_kwargs={"input_data": "hello"})
        assert captured.get("input_data") == "hello"


# ---------------------------------------------------------------------------
# Tests: error handling
# ---------------------------------------------------------------------------

class TestErrorHandling:
    def test_stop_on_error_true_halts_chain(self):
        chain = AgentChain({'stop_on_error': True})
        chain.add_step("s1", FailingAgent())
        chain.add_step("s2", EchoAgent())
        result = chain.run()
        assert result.status == "error"
        assert result.failed_step == "s1"
        assert len(result.steps) == 1  # s2 never ran

    def test_stop_on_error_false_continues(self):
        chain = AgentChain({'stop_on_error': False})
        chain.add_step("s1", FailingAgent())
        chain.add_step("s2", EchoAgent())
        result = chain.run()
        assert result.status == "partial"
        assert len(result.steps) == 2  # both ran

    def test_error_result_has_error_message(self):
        chain = AgentChain({'stop_on_error': True})
        chain.add_step("s1", FailingAgent())
        result = chain.run()
        assert result.error is not None
        assert "intentional" in result.error


# ---------------------------------------------------------------------------
# Tests: empty chain
# ---------------------------------------------------------------------------

class TestEmptyChain:
    def test_empty_chain_returns_success(self):
        chain = AgentChain()
        result = chain.run()
        assert result.status == "success"
        assert len(result.steps) == 0
        assert result.final_result is None
