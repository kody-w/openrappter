"""Tests for Showcase: Ouroboros Accelerator - AgentChain + Code Review."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.chain import AgentChain


class EvolutionAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Evolution", "description": "Evolves code", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Evolution", metadata=metadata)

    def perform(self, **kwargs):
        source = kwargs.get("source", "function add(a,b) { return a+b; }")
        evolved = source.replace("function", "export function")
        return json.dumps({
            "status": "success",
            "evolved_source": evolved,
            "generation": 1,
            "improvements": ["added export", "maintained purity"],
            "data_slush": {"source_agent": "Evolution", "generation": 1, "evolved_source": evolved, "improvement_count": 2},
        })


class ReviewAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "CodeReview", "description": "Reviews code", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="CodeReview", metadata=metadata)

    def perform(self, **kwargs):
        content = kwargs.get("content", "")
        has_export = "export" in content
        has_types = ":" in content
        return json.dumps({
            "status": "success",
            "review": {"quality_score": 85 if has_export else 60, "issues": [] if has_types else ["Missing type annotations"], "passed": has_export},
            "data_slush": {"source_agent": "CodeReview", "quality_score": 85 if has_export else 60, "passed": has_export},
        })


class FailingEvolution(BasicAgent):
    def __init__(self):
        metadata = {"name": "FailingEvolution", "description": "Fails", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="FailingEvolution", metadata=metadata)

    def perform(self, **kwargs):
        raise RuntimeError("Evolution crashed")


class TestChainFlow:
    def test_chain_evolution_then_review(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent(), {"source": "function add(a,b) { return a+b; }"})
        chain.add_step("review", ReviewAgent(), transform=lambda prev, slush: {"content": prev.get("evolved_source", "")})
        result = chain.run()
        assert result.status == "success"
        assert len(result.steps) == 2
        assert result.steps[0].name == "evolve"
        assert result.steps[1].name == "review"

    def test_pass_evolved_source_to_review_via_transform(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent(), {"source": "function greet() { return 'hi'; }"})
        chain.add_step("review", ReviewAgent(), transform=lambda prev, slush: {"content": prev.get("evolved_source", "")})
        result = chain.run()
        review_result = result.steps[1].result
        review = review_result["review"]
        assert review["passed"] is True
        assert review["quality_score"] == 85

    def test_propagate_data_slush_through_chain(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent())
        chain.add_step("review", ReviewAgent(), transform=lambda prev, slush: {"content": prev.get("evolved_source", "")})
        result = chain.run()
        assert result.steps[0].data_slush is not None
        assert result.steps[0].data_slush["source_agent"] == "Evolution"
        assert result.steps[1].data_slush is not None
        assert result.steps[1].data_slush["source_agent"] == "CodeReview"


class TestEvolutionQuality:
    def test_produce_improved_code(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent(), {"source": "function hello() {}"})
        result = chain.run()
        evolve_result = result.steps[0].result
        assert "export" in evolve_result["evolved_source"]
        assert evolve_result["generation"] == 1


class TestReviewFeedback:
    def test_identify_missing_type_annotations(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent())
        chain.add_step("review", ReviewAgent(), transform=lambda prev, slush: {"content": prev.get("evolved_source", "")})
        result = chain.run()
        review = result.steps[1].result["review"]
        assert "Missing type annotations" in review["issues"]


class TestChainErrorHandling:
    def test_stop_on_error_by_default(self):
        chain = AgentChain()
        chain.add_step("evolve", FailingEvolution())
        chain.add_step("review", ReviewAgent())
        result = chain.run()
        assert result.status == "error"
        assert result.failed_step == "evolve"
        assert len(result.steps) == 1


class TestFinalResult:
    def test_return_review_as_final_result(self):
        chain = AgentChain()
        chain.add_step("evolve", EvolutionAgent())
        chain.add_step("review", ReviewAgent(), transform=lambda prev, slush: {"content": prev.get("evolved_source", "")})
        result = chain.run()
        assert result.final_result["status"] == "success"
        assert "review" in result.final_result
        assert result.final_slush["source_agent"] == "CodeReview"
