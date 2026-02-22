"""Tests for Showcase: Inception Stack - Recursive agent meta-creation."""

import asyncio
import concurrent.futures
import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.subagent import SubAgentManager
from openrappter.agents.tracer import create_tracer, TraceContext


def run_async(coro):
    """Run a coroutine in a fresh event loop on a background thread.

    This is needed when the call site is already inside a running event loop
    (e.g., inside an async executor called via run_until_complete).  Calling
    get_event_loop().run_until_complete() on the *same* loop raises
    'This event loop is already running'.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(asyncio.run, coro)
        return future.result()


def create_inception_agents():
    """Create the 3-level inception agent hierarchy with shared agents map."""
    agents = {}

    class DreamExtractorAgent(BasicAgent):
        def __init__(self):
            metadata = {"name": "DreamExtractor", "description": "Extracts dream data (Level 3)", "parameters": {"type": "object", "properties": {}, "required": []}}
            super().__init__(name="DreamExtractor", metadata=metadata)

        def perform(self, **kwargs):
            seed = kwargs.get("dream_seed", "")
            char_count = len(seed)
            vowel_count = sum(1 for c in seed if c.lower() in "aeiou")
            totem = f"totem_{char_count}_{vowel_count}"
            return json.dumps({
                "status": "success",
                "level": 3,
                "extraction": {"char_count": char_count, "vowel_count": vowel_count},
                "totem": totem,
                "data_slush": {"source_agent": "DreamExtractor", "level": 3, "totem": totem, "char_count": char_count},
            })

    class DreamBuilderAgent(BasicAgent):
        def __init__(self):
            metadata = {"name": "DreamBuilder", "description": "Builds dream (Level 2)", "parameters": {"type": "object", "properties": {}, "required": []}}
            super().__init__(name="DreamBuilder", metadata=metadata)

        def perform(self, **kwargs):
            manager = kwargs.get("_manager")
            parent_ctx = kwargs.get("_subagent_context")
            dream_seed = kwargs.get("dream_seed", "")
            extractor = DreamExtractorAgent()
            agents["DreamExtractor"] = extractor
            # Use run_async to avoid "event loop already running" when called from inside a coroutine
            inner_result = run_async(manager.invoke("DreamExtractor", dream_seed, parent_ctx))
            inner = inner_result if isinstance(inner_result, dict) else json.loads(inner_result)
            return json.dumps({
                "status": "success",
                "level": 2,
                "inner": inner,
                "data_slush": {"source_agent": "DreamBuilder", "level": 2, "inner_totem": inner.get("totem")},
            })

    class DreamArchitectAgent(BasicAgent):
        def __init__(self, max_depth=4):
            self._max_depth = max_depth
            metadata = {"name": "DreamArchitect", "description": "Designs inception stack (Level 1)", "parameters": {"type": "object", "properties": {}, "required": []}}
            super().__init__(name="DreamArchitect", metadata=metadata)

        def perform(self, **kwargs):
            dream_seed = kwargs.get("dream_seed", "")
            manager = SubAgentManager({"maxDepth": self._max_depth})

            async def executor(agent_id, message, context, upstream_slush=None):
                agent = agents.get(agent_id)
                if not agent:
                    raise RuntimeError(f"Agent not found: {agent_id}")
                result_str = agent.execute(dream_seed=message, _manager=manager, _subagent_context=context)
                return json.loads(result_str)

            manager.set_executor(executor)
            builder = DreamBuilderAgent()
            agents["DreamBuilder"] = builder
            ctx = manager.create_context("DreamArchitect")
            inner_result = asyncio.get_event_loop().run_until_complete(manager.invoke("DreamBuilder", dream_seed, ctx))
            inner = inner_result if isinstance(inner_result, dict) else json.loads(inner_result)
            return json.dumps({
                "status": "success",
                "level": 1,
                "inner": inner,
                "data_slush": {"source_agent": "DreamArchitect", "level": 1, "stack_depth": 3},
            })

    return agents, DreamExtractorAgent, DreamBuilderAgent, DreamArchitectAgent


class TestRecursiveAgentCreation:
    def test_level_3_produces_correct_extraction(self):
        _, DreamExtractorAgent, _, _ = create_inception_agents()
        extractor = DreamExtractorAgent()
        result = json.loads(extractor.execute(dream_seed="lucid dreaming"))
        assert result["status"] == "success"
        assert result["level"] == 3
        assert result["extraction"]["char_count"] == 14
        assert result["extraction"]["vowel_count"] == 5
        assert result["totem"] == "totem_14_5"

    def test_level_2_creates_and_invokes_level_3(self):
        agents, DreamExtractorAgent, DreamBuilderAgent, _ = create_inception_agents()
        manager = SubAgentManager({"maxDepth": 5})

        async def executor(agent_id, message, context, upstream_slush=None):
            agent = agents.get(agent_id)
            if not agent:
                raise RuntimeError(f"Agent not found: {agent_id}")
            result_str = agent.execute(dream_seed=message, _manager=manager, _subagent_context=context)
            return json.loads(result_str)

        manager.set_executor(executor)
        builder = DreamBuilderAgent()
        agents["DreamBuilder"] = builder
        ctx = manager.create_context("TestRoot")
        result = json.loads(builder.execute(dream_seed="hello", _manager=manager, _subagent_context=ctx))
        assert result["level"] == 2
        assert result["inner"] is not None
        assert result["inner"]["level"] == 3
        assert result["inner"]["totem"] == "totem_5_2"

    def test_full_3_level_inception_stack(self):
        _, _, _, DreamArchitectAgent = create_inception_agents()
        architect = DreamArchitectAgent(4)
        result = json.loads(architect.execute(dream_seed="inception"))
        assert result["status"] == "success"
        assert result["level"] == 1
        assert result["inner"]["level"] == 2
        assert result["inner"]["inner"]["level"] == 3
        assert result["inner"]["inner"]["totem"] is not None


class TestDataSlushBubbling:
    def test_nested_data_slush_has_all_3_levels(self):
        _, _, _, DreamArchitectAgent = create_inception_agents()
        architect = DreamArchitectAgent(4)
        result = json.loads(architect.execute(dream_seed="dream"))
        assert result["data_slush"]["source_agent"] == "DreamArchitect"
        assert result["data_slush"]["level"] == 1
        assert result["inner"]["data_slush"]["source_agent"] == "DreamBuilder"
        assert result["inner"]["data_slush"]["level"] == 2
        assert result["inner"]["inner"]["data_slush"]["source_agent"] == "DreamExtractor"
        assert result["inner"]["inner"]["data_slush"]["level"] == 3

    def test_each_level_preserves_source_agent(self):
        _, _, _, DreamArchitectAgent = create_inception_agents()
        architect = DreamArchitectAgent(4)
        result = json.loads(architect.execute(dream_seed="test"))
        agent_names = [
            result["data_slush"]["source_agent"],
            result["inner"]["data_slush"]["source_agent"],
            result["inner"]["inner"]["data_slush"]["source_agent"],
        ]
        assert agent_names == ["DreamArchitect", "DreamBuilder", "DreamExtractor"]


class TestSubAgentDepthTracking:
    def test_tracks_depth_across_levels(self):
        agents, _, DreamBuilderAgent, _ = create_inception_agents()
        depths = []
        manager = SubAgentManager({"maxDepth": 5})

        async def executor(agent_id, message, context, upstream_slush=None):
            depths.append(context.get("depth", -1))
            agent = agents.get(agent_id)
            if not agent:
                raise RuntimeError(f"Agent not found: {agent_id}")
            result_str = agent.execute(dream_seed=message, _manager=manager, _subagent_context=context)
            return json.loads(result_str)

        manager.set_executor(executor)
        builder = DreamBuilderAgent()
        agents["DreamBuilder"] = builder
        ctx = manager.create_context("TestRoot")
        asyncio.get_event_loop().run_until_complete(manager.invoke("DreamBuilder", "test", ctx))
        assert depths == [1, 2]

    def test_blocks_when_max_depth_exceeded(self):
        manager = SubAgentManager({"maxDepth": 1})

        async def executor(agent_id, message, context, upstream_slush=None):
            return {"status": "success"}

        manager.set_executor(executor)
        ctx = manager.create_context("DreamArchitect")
        asyncio.get_event_loop().run_until_complete(manager.invoke("DreamBuilder", "test", ctx))
        deep_ctx = dict(ctx)
        deep_ctx["depth"] = 1
        deep_ctx["callId"] = "deep"
        deep_ctx["parentAgentId"] = "DreamBuilder"
        deep_ctx["history"] = list(ctx["history"])
        with pytest.raises(RuntimeError, match="Cannot invoke agent DreamExtractor"):
            asyncio.get_event_loop().run_until_complete(manager.invoke("DreamExtractor", "test", deep_ctx))

    def test_allows_all_3_levels_with_sufficient_depth(self):
        _, _, _, DreamArchitectAgent = create_inception_agents()
        architect = DreamArchitectAgent(4)
        result = json.loads(architect.execute(dream_seed="deep enough"))
        assert result["level"] == 1
        assert result["inner"]["level"] == 2
        assert result["inner"]["inner"]["level"] == 3


class TestAgentTracing:
    def test_nested_parent_child_trace_spans(self):
        tracer = create_tracer({"record_io": True})
        l1_span, ctx1 = tracer.start_span("DreamArchitect", "execute")
        l2_span, ctx2 = tracer.start_span("DreamBuilder", "execute", ctx1)
        l3_span, _ = tracer.start_span("DreamExtractor", "execute", ctx2)
        tracer.end_span(l3_span.id, {"status": "success"})
        tracer.end_span(l2_span.id, {"status": "success"})
        tracer.end_span(l1_span.id, {"status": "success"})
        trace = tracer.get_trace(ctx1.trace_id)
        assert len(trace) == 3
        span_map = {s.agent_name: s for s in trace}
        root = span_map["DreamArchitect"]
        mid = span_map["DreamBuilder"]
        leaf = span_map["DreamExtractor"]
        assert root.parent_id is None
        assert mid.parent_id == l1_span.id
        assert leaf.parent_id == l2_span.id
        trace_ids = set(s.trace_id for s in trace)
        assert len(trace_ids) == 1

    def test_correct_agent_names_in_trace(self):
        tracer = create_tracer()
        _, ctx1 = tracer.start_span("DreamArchitect", "execute")
        _, ctx2 = tracer.start_span("DreamBuilder", "execute", ctx1)
        l3_span, _ = tracer.start_span("DreamExtractor", "execute", ctx2)
        tracer.end_span(l3_span.id, {"status": "success"})
        tracer.end_span(ctx2.span_id, {"status": "success"})
        tracer.end_span(ctx1.span_id, {"status": "success"})
        trace = tracer.get_trace(ctx1.trace_id)
        names = set(s.agent_name for s in trace)
        assert names == {"DreamArchitect", "DreamBuilder", "DreamExtractor"}
