#!/usr/bin/env python3
"""Unit tests for the streaming chat path (call_copilot_stream + /chat/stream).

These use mocked SSE payloads and mocked LLM calls — no network, no auth. They
cover the four things that make streaming safe:
  1. content delta accumulation
  2. tool_call fragment merging (id/name/arguments split across chunks)
  3. unsupported-model fallback (StreamingUnsupported raised before any delta)
  4. client-disconnect cleanup (the HTTP response is closed on generator close)
plus endpoint-level wiring: delta+done events, internal non-streaming fallback,
and a tool round emitting an 'agent' event.
"""

import os
import sys
import json
import unittest
from unittest import mock

BRAINSTEM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BRAINSTEM_DIR not in sys.path:
    sys.path.insert(0, BRAINSTEM_DIR)

import brainstem


class FakeStreamResp:
    """Minimal stand-in for a streaming requests.Response."""

    def __init__(self, lines, status=200, text=""):
        self._lines = lines
        self.status_code = status
        self._text = text
        self.encoding = None
        self.closed = False

    def iter_lines(self, decode_unicode=False):
        for ln in self._lines:
            yield ln

    @property
    def text(self):
        return self._text

    def close(self):
        self.closed = True


def _drive_accum(gen):
    """Run an _accumulate_stream generator; return (deltas, final_dict)."""
    deltas = []
    final = None
    try:
        while True:
            kind, payload = next(gen)
            if kind == "delta":
                deltas.append(payload)
    except StopIteration as e:
        final = e.value
    return deltas, final


def _parse_sse(text):
    """Parse an SSE body into a list of decoded JSON event dicts."""
    events = []
    for block in text.split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data:"):
                try:
                    events.append(json.loads(line[5:].strip()))
                except Exception:
                    pass
    return events


class TestDeltaAccumulation(unittest.TestCase):
    def test_content_deltas_accumulate_in_order(self):
        lines = [
            'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"Hello"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":", world"}}]}',
            "",
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "",
            "data: [DONE]",
            "",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        self.assertEqual(deltas, ["Hello", ", world"])
        self.assertEqual(final["message"]["content"], "Hello, world")
        self.assertEqual(final["finish_reason"], "stop")
        self.assertNotIn("tool_calls", final["message"])

    def test_empty_content_yields_no_deltas(self):
        lines = [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        self.assertEqual(deltas, [])
        self.assertIsNone(final["message"]["content"])

    def test_ignores_heartbeats_and_garbage(self):
        lines = [
            ": keep-alive heartbeat",
            "",
            "event: ping",
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: {not valid json",
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        self.assertEqual(deltas, ["ok"])
        self.assertEqual(final["message"]["content"], "ok")

    def test_unmarked_eof_after_partial_content_is_incomplete(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"partial"}}]}',
        ]

        with self.assertRaises(brainstem.requests.exceptions.ConnectionError):
            _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))


class TestToolCallMerging(unittest.TestCase):
    def test_tool_call_fragments_merge_into_one_call(self):
        # id + name arrive whole in the first fragment; arguments stream in pieces.
        lines = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"HackerNews","arguments":""}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"count\\""}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":": 5}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        self.assertEqual(deltas, [])
        tcs = final["message"]["tool_calls"]
        self.assertEqual(len(tcs), 1)
        self.assertEqual(tcs[0]["id"], "call_abc")
        self.assertEqual(tcs[0]["function"]["name"], "HackerNews")
        self.assertEqual(json.loads(tcs[0]["function"]["arguments"]), {"count": 5})
        self.assertEqual(final["finish_reason"], "tool_calls")

    def test_two_parallel_tool_calls_keyed_by_index(self):
        lines = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"A","arguments":"{}"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"B","arguments":"{}"}}]}}]}',
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        tcs = final["message"]["tool_calls"]
        self.assertEqual([t["function"]["name"] for t in tcs], ["A", "B"])
        self.assertEqual([t["id"] for t in tcs], ["c0", "c1"])

    def test_missing_id_is_synthesized(self):
        lines = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"NoId","arguments":"{}"}}]}}]}',
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        tcs = final["message"]["tool_calls"]
        self.assertEqual(len(tcs), 1)
        self.assertTrue(tcs[0]["id"])  # a non-empty id was filled in

    def test_claude_multichoice_content_and_tools_merge(self):
        # Claude via Copilot can split text and tool_calls onto separate choice
        # indices; content is keyed independently, tool_calls by tool index.
        lines = [
            'data: {"choices":[{"index":0,"delta":{"content":"Let me check. "}}]}',
            'data: {"choices":[{"index":1,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"HackerNews","arguments":"{}"}}]}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            "data: [DONE]",
        ]
        deltas, final = _drive_accum(brainstem._accumulate_stream(FakeStreamResp(lines)))
        self.assertEqual(deltas, ["Let me check. "])
        self.assertEqual(final["message"]["content"], "Let me check. ")
        self.assertEqual(final["message"]["tool_calls"][0]["function"]["name"], "HackerNews")


class TestUnsupportedModelFallback(unittest.TestCase):
    def test_non_200_raises_streaming_unsupported_before_any_delta(self):
        resp = FakeStreamResp([], status=400, text='{"error":"model does not support streaming"}')
        with mock.patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://ep/v1")), \
             mock.patch.object(brainstem.requests, "post", return_value=resp) as post:
            gen = brainstem.call_copilot_stream([{"role": "user", "content": "hi"}], model="o1-preview")
            with self.assertRaises(brainstem.StreamingUnsupported) as ctx:
                next(gen)  # POST + status check happen on first iteration
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(ctx.exception.model, "o1-preview")
        self.assertTrue(resp.closed)          # response was released before raising
        self.assertTrue(post.called)
        # stream:true was actually requested
        self.assertTrue(post.call_args.kwargs["json"]["stream"])

    def test_o1_model_omits_tool_choice(self):
        resp = FakeStreamResp(["data: [DONE]"], status=200)
        brainstem._NO_TOOL_CHOICE_MODELS.add("o1-mini")
        try:
            with mock.patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://ep/v1")), \
                 mock.patch.object(brainstem.requests, "post", return_value=resp) as post:
                gen = brainstem.call_copilot_stream(
                    [{"role": "user", "content": "hi"}],
                    tools=[{"type": "function", "function": {"name": "X"}}],
                    model="o1-mini",
                )
                list(gen)
            body = post.call_args.kwargs["json"]
            self.assertNotIn("tool_choice", body)
        finally:
            brainstem._NO_TOOL_CHOICE_MODELS.discard("o1-mini")


class TestDisconnectCleanup(unittest.TestCase):
    def test_generator_close_closes_response(self):
        # Simulate a client disconnect: consume one delta, then close the generator.
        # The try/finally in call_copilot_stream must close the HTTP response so no
        # socket/thread is orphaned.
        lines = []
        for i in range(50):
            lines.append('data: {"choices":[{"delta":{"content":"tok%d"}}]}' % i)
            lines.append("")
        resp = FakeStreamResp(lines, status=200)
        with mock.patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://ep/v1")), \
             mock.patch.object(brainstem.requests, "post", return_value=resp):
            gen = brainstem.call_copilot_stream([{"role": "user", "content": "hi"}], model="gpt-4o")
            first = next(gen)
            self.assertEqual(first, ("delta", "tok0"))
            self.assertFalse(resp.closed)
            gen.close()  # raises GeneratorExit inside the generator
            self.assertTrue(resp.closed)

    def test_full_consumption_closes_response(self):
        lines = [
            'data: {"choices":[{"delta":{"content":"hi"}}]}',
            "data: [DONE]",
        ]
        resp = FakeStreamResp(lines, status=200)
        with mock.patch.object(brainstem, "get_copilot_token", return_value=("tok", "https://ep/v1")), \
             mock.patch.object(brainstem.requests, "post", return_value=resp):
            events = list(brainstem.call_copilot_stream([{"role": "user", "content": "hi"}], model="gpt-4o"))
        kinds = [e[0] for e in events]
        self.assertIn("done", kinds)
        done = [e for e in events if e[0] == "done"][0][1]
        self.assertEqual(done["message"]["content"], "hi")
        self.assertEqual(done["model"], "gpt-4o")
        self.assertTrue(resp.closed)


class TestChatStreamEndpoint(unittest.TestCase):
    def setUp(self):
        self.client = brainstem.app.test_client()

    def test_streams_deltas_then_done(self):
        def fake_stream(messages, tools=None, model=None):
            yield ("delta", "Hel")
            yield ("delta", "lo")
            yield ("done", {"message": {"role": "assistant", "content": "Hello"},
                            "model": "gpt-4o", "finish_reason": "stop"})

        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={}), \
             mock.patch.object(brainstem, "call_copilot_stream", side_effect=fake_stream):
            resp = self.client.post("/chat/stream", json={"user_input": "hi"})
            self.assertEqual(resp.status_code, 200)
            self.assertIn("text/event-stream", resp.headers["Content-Type"])
            events = _parse_sse(resp.get_data(as_text=True))
        deltas = [e["text"] for e in events if e["type"] == "delta"]
        self.assertEqual(deltas, ["Hel", "lo"])
        done = [e for e in events if e["type"] == "done"][0]
        self.assertEqual(done["response"], "Hello")
        self.assertTrue(done["streamed"])
        self.assertEqual(done["model"], "gpt-4o")

    def test_endpoint_falls_back_when_stream_unsupported(self):
        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={}), \
             mock.patch.object(brainstem, "call_copilot_stream",
                               side_effect=brainstem.StreamingUnsupported(400, "no", "o1")), \
             mock.patch.object(brainstem, "call_copilot",
                               return_value=({"choices": [{"message": {"role": "assistant", "content": "hi there"},
                                                           "finish_reason": "stop"}]}, "gpt-4o")):
            resp = self.client.post("/chat/stream", json={"user_input": "hello"})
            events = _parse_sse(resp.get_data(as_text=True))
        # Even without real streaming, the full content is emitted as one delta...
        self.assertTrue(any(e["type"] == "delta" and e["text"] == "hi there" for e in events))
        done = [e for e in events if e["type"] == "done"][0]
        self.assertEqual(done["response"], "hi there")
        self.assertFalse(done["streamed"])  # ...and marked as a fallback

    def test_non_streaming_fallback_transport_error_is_clean(self):
        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={}), \
             mock.patch.object(
                 brainstem, "call_copilot_stream",
                 side_effect=brainstem.StreamingUnsupported(400, "no", "o1"),
             ), \
             mock.patch.object(
                 brainstem, "call_copilot",
                 side_effect=brainstem.requests.exceptions.ConnectionError(
                     "raw connection detail"
                 ),
             ):
            response = self.client.post("/chat/stream", json={"user_input": "hello"})
            events = _parse_sse(response.get_data(as_text=True))

        errors = [event for event in events if event["type"] == "error"]
        self.assertEqual(errors[-1]["error"], brainstem._STREAM_INTERRUPTED_USER_MSG)
        self.assertNotIn("raw connection detail", errors[-1]["error"])
        self.assertFalse(any(event["type"] == "done" for event in events))

    def test_tool_round_emits_agent_event(self):
        class FakeAgent:
            name = "HackerNews"

            def to_tool(self):
                return {"type": "function", "function": {"name": "HackerNews", "parameters": {"type": "object", "properties": {}}}}

            def system_context(self):
                return ""

            def perform(self, **kwargs):
                return '{"summary":"Top story: the Rust rewrite ships"}'

        state = {"n": 0}

        def fake_stream(messages, tools=None, model=None):
            state["n"] += 1
            if state["n"] == 1:
                yield ("done", {"message": {"role": "assistant", "content": None,
                                            "tool_calls": [{"id": "c1", "type": "function",
                                                            "function": {"name": "HackerNews", "arguments": "{}"}}]},
                                "model": "gpt-4o", "finish_reason": "tool_calls"})
            else:
                yield ("delta", "Here is ")
                yield ("delta", "the top story.")
                yield ("done", {"message": {"role": "assistant", "content": "Here is the top story."},
                                "model": "gpt-4o", "finish_reason": "stop"})

        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={"HackerNews": FakeAgent()}), \
             mock.patch.object(brainstem, "call_copilot_stream", side_effect=fake_stream):
            resp = self.client.post("/chat/stream", json={"user_input": "get my latest hacker news"})
            events = _parse_sse(resp.get_data(as_text=True))
        types = [e["type"] for e in events]
        self.assertIn("agent", types)
        agent_evt = [e for e in events if e["type"] == "agent"][0]
        self.assertIn("HackerNews", agent_evt["logs"])
        done = [e for e in events if e["type"] == "done"][0]
        self.assertIn("top story", done["response"].lower())

    def test_tool_budget_finalizes_interim_text_with_tools_disabled(self):
        class LookupAgent:
            name = "Lookup"

            def to_tool(self):
                return {"type": "function", "function": {
                    "name": self.name,
                    "parameters": {"type": "object", "properties": {}},
                }}

            def system_context(self):
                return ""

            def perform(self, **kwargs):
                return "the final fact"

        calls = []

        def fake_stream(messages, tools=None, model=None):
            calls.append(tools)
            if len(calls) <= 3:
                yield ("delta", "Let me check.")
                yield ("done", {
                    "message": {
                        "role": "assistant",
                        "content": "Let me check.",
                        "tool_calls": [{
                            "id": f"call-{len(calls)}",
                            "type": "function",
                            "function": {"name": "Lookup", "arguments": "{}"},
                        }],
                    },
                    "model": "gpt-4o",
                    "finish_reason": "tool_calls",
                })
            else:
                yield ("delta", "The answer uses the final fact.")
                yield ("done", {
                    "message": {
                        "role": "assistant",
                        "content": "The answer uses the final fact.",
                    },
                    "model": "gpt-4o",
                    "finish_reason": "stop",
                })

        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={"Lookup": LookupAgent()}), \
             mock.patch.object(brainstem, "call_copilot_stream", side_effect=fake_stream):
            response = self.client.post("/chat/stream", json={"user_input": "look it up"})
            events = _parse_sse(response.get_data(as_text=True))

        done = [event for event in events if event["type"] == "done"][0]
        self.assertEqual(done["response"], "The answer uses the final fact.")
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(tools for tools in calls[:3]))
        self.assertIsNone(calls[3])

    def test_chunked_stream_interruption_emits_clean_error_without_done(self):
        def interrupted_stream(messages, tools=None, model=None):
            yield ("delta", "partial")
            raise brainstem.requests.exceptions.ChunkedEncodingError("raw transport detail")

        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={}), \
             mock.patch.object(brainstem, "call_copilot_stream", side_effect=interrupted_stream):
            response = self.client.post("/chat/stream", json={"user_input": "hi"})
            events = _parse_sse(response.get_data(as_text=True))

        errors = [event for event in events if event["type"] == "error"]
        self.assertEqual(errors[-1]["error"], brainstem._STREAM_INTERRUPTED_USER_MSG)
        self.assertNotIn("raw transport detail", errors[-1]["error"])
        self.assertFalse(any(event["type"] == "done" for event in events))

    def test_missing_user_input_is_400(self):
        resp = self.client.post("/chat/stream", json={"user_input": "   "})
        self.assertEqual(resp.status_code, 400)

    def test_disconnect_stops_generation_promptly(self):
        # Closing the client-side response iterator must propagate GeneratorExit into
        # the server generator and stop it — no further rounds run.
        rounds = {"n": 0}

        def fake_stream(messages, tools=None, model=None):
            rounds["n"] += 1
            for i in range(3):
                yield ("delta", "chunk%d " % i)
            yield ("done", {"message": {"role": "assistant", "content": "chunk0 chunk1 chunk2 "},
                            "model": "gpt-4o", "finish_reason": "stop"})

        with mock.patch.object(brainstem, "load_soul", return_value="SOUL"), \
             mock.patch.object(brainstem, "load_agents", return_value={}), \
             mock.patch.object(brainstem, "call_copilot_stream", side_effect=fake_stream):
            resp = self.client.post("/chat/stream", json={"user_input": "hi"})
            it = resp.response  # the underlying generator
            first = next(it)
            self.assertIn("data:", first if isinstance(first, str) else first.decode())
            resp.close()  # simulate client disconnect
        # The generator was closed after one read; it never looped a second round.
        self.assertEqual(rounds["n"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
