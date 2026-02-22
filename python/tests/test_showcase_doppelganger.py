"""Tests for Showcase: Doppelganger - AgentTracer + clone comparison."""

import json
import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.agents.tracer import create_tracer


class TextProcessorAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "TextProcessor", "description": "Text analysis", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="TextProcessor", metadata=metadata)

    def perform(self, **kwargs):
        text = kwargs.get("text", "")
        words = text.split()
        longest = max(words, key=len) if words else ""
        reversed_text = text[::-1]
        return json.dumps({
            "status": "success",
            "word_count": len(words),
            "longest_word": longest,
            "reversed": reversed_text,
            "data_slush": {"source_agent": "TextProcessor", "word_count": len(words), "longest_word": longest},
        })


class TextProcessorCloneAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "TextProcessorClone", "description": "Clone of TextProcessor", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="TextProcessorClone", metadata=metadata)

    def perform(self, **kwargs):
        text = kwargs.get("text", "")
        words = text.split()
        longest = max(words, key=len) if words else ""
        reversed_text = text[::-1]
        return json.dumps({
            "status": "success",
            "word_count": len(words),
            "longest_word": longest,
            "reversed": reversed_text,
            "data_slush": {"source_agent": "TextProcessorClone", "word_count": len(words), "longest_word": longest},
        })


class ComparisonAgent(BasicAgent):
    def __init__(self):
        metadata = {"name": "Comparison", "description": "Compares outputs", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="Comparison", metadata=metadata)

    def perform(self, **kwargs):
        original = kwargs.get("original_result", {})
        clone = kwargs.get("clone_result", {})
        wc_match = original.get("word_count") == clone.get("word_count")
        lw_match = original.get("longest_word") == clone.get("longest_word")
        rv_match = original.get("reversed") == clone.get("reversed")
        identical = wc_match and lw_match and rv_match
        return json.dumps({
            "status": "success",
            "identical": identical,
            "matches": {"word_count": wc_match, "longest_word": lw_match, "reversed": rv_match},
            "data_slush": {"source_agent": "Comparison", "identical": identical, "match_count": sum([wc_match, lw_match, rv_match])},
        })


class DivergentClone(BasicAgent):
    def __init__(self):
        metadata = {"name": "DivergentClone", "description": "Wrong clone", "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name="DivergentClone", metadata=metadata)

    def perform(self, **kwargs):
        text = kwargs.get("text", "")
        return json.dumps({"status": "success", "word_count": 999, "longest_word": "wrong", "reversed": text})


class TestTraceCapture:
    def test_capture_agent_io_in_trace_spans(self):
        tracer = create_tracer({"record_io": True})
        agent = TextProcessorAgent()
        span, context = tracer.start_span("TextProcessor", "execute", inputs={"text": "hello world"})
        result_str = agent.execute(text="hello world")
        result = json.loads(result_str)
        tracer.end_span(span.id, {"status": "success", "outputs": result})
        trace = tracer.get_trace(context.trace_id)
        assert len(trace) == 1
        assert trace[0].agent_name == "TextProcessor"
        assert trace[0].status == "success"
        assert trace[0].inputs["text"] == "hello world"
        assert trace[0].outputs is not None

    def test_record_duration_in_trace(self):
        tracer = create_tracer()
        agent = TextProcessorAgent()
        span, _ = tracer.start_span("TextProcessor", "execute")
        agent.execute(text="test")
        completed = tracer.end_span(span.id, {"status": "success"})
        assert completed.duration_ms >= 0
        assert completed.end_time is not None


class TestCloneFromTrace:
    def test_build_clone_description_from_trace(self):
        tracer = create_tracer({"record_io": True})
        agent = TextProcessorAgent()
        span, context = tracer.start_span("TextProcessor", "execute", inputs={"text": "test input"})
        result_str = agent.execute(text="test input")
        tracer.end_span(span.id, {"status": "success", "outputs": json.loads(result_str)})
        trace = tracer.get_trace(context.trace_id)
        description = f"Agent that processes text: inputs {json.dumps(trace[0].inputs)}, produces word_count, longest_word, reversed"
        assert "text" in description
        assert "word_count" in description


class TestChainComparison:
    def test_identical_outputs(self):
        input_text = "The quick brown fox jumps over the lazy dog"
        original = TextProcessorAgent()
        orig_result = json.loads(original.execute(text=input_text))
        clone = TextProcessorCloneAgent()
        clone_result = json.loads(clone.execute(text=input_text))
        comparator = ComparisonAgent()
        comp_result = json.loads(comparator.execute(original_result=orig_result, clone_result=clone_result))
        assert comp_result["identical"] is True
        assert comp_result["matches"]["word_count"] is True
        assert comp_result["matches"]["longest_word"] is True
        assert comp_result["matches"]["reversed"] is True

    def test_detect_divergence(self):
        original = TextProcessorAgent()
        orig_result = json.loads(original.execute(text="hello world"))
        divergent = DivergentClone()
        div_result = json.loads(divergent.execute(text="hello world"))
        comparator = ComparisonAgent()
        comp_result = json.loads(comparator.execute(original_result=orig_result, clone_result=div_result))
        assert comp_result["identical"] is False
        assert comp_result["matches"]["word_count"] is False


class TestTraceProfile:
    def test_extract_description_from_multiple_traces(self):
        tracer = create_tracer({"record_io": True})
        agent = TextProcessorAgent()
        for text in ["hello", "hello world", "one two three four five"]:
            span, _ = tracer.start_span("TextProcessor", "execute", inputs={"text": text})
            result_str = agent.execute(text=text)
            tracer.end_span(span.id, {"status": "success", "outputs": json.loads(result_str)})
        completed = tracer.get_completed_spans()
        assert len(completed) == 3
        assert all(s.agent_name == "TextProcessor" for s in completed)
