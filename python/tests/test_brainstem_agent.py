"""The brainstem agent, driven without a brainstem.

PR #226 gave a person a dropdown to choose which brain answers. This agent gives
the assistant the same reach, so a user can ask for the brainstem's view and stay
in one conversation instead of switching brains by hand and relaying the answer.

Everything worth testing here is a failure the operator would otherwise see as a
confident wrong answer:

  - something else answering on that port, passed back as the brainstem's words
  - a reply that is JSON but not a §2.4 envelope
  - the kernel's `user_input` requirement, which a live brainstem answers 400
    without and which no unit test written against the documentation would catch

The happy path is checked too, but a brainstem that is simply down is loud and
self-explanatory; these are the quiet ones.
"""

import json
from io import BytesIO

import pytest

from openrappter.agents.brainstem_agent import (
    CANDIDATE_URLS,
    BrainstemAgent,
)


ENVELOPE = {
    "response": "Hello from the brainstem.",
    "session_id": "session-1",
    "agent_logs": "",
    "voice_mode": False,
    "model": "claude-opus-4.6",
    "requested_model": "auto",
}


class FakeResponse(BytesIO):
    """Enough of an http.client.HTTPResponse for urlopen's context manager."""

    def __init__(self, payload, status=200):
        super().__init__(payload.encode("utf-8") if isinstance(payload, str) else payload)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


@pytest.fixture
def agent():
    return BrainstemAgent()


def install_urlopen(monkeypatch, handler):
    """Route every request the agent makes through `handler(url, method, body)`."""
    calls = []

    def fake_urlopen(request, timeout=None):
        body = None
        if request.data:
            body = json.loads(request.data.decode("utf-8"))
        calls.append({
            "url": request.full_url,
            "method": request.get_method(),
            "body": body,
            "timeout": timeout,
        })
        return handler(request.full_url, request.get_method(), body)

    monkeypatch.setattr(
        "openrappter.agents.brainstem_agent.urllib.request.urlopen", fake_urlopen
    )
    return calls


def healthy_then(envelope, status=200):
    def handler(url, method, body):
        if url.endswith("/health"):
            return FakeResponse('{"status":"ok"}')
        return FakeResponse(json.dumps(envelope) if isinstance(envelope, dict) else envelope, status)
    return handler


class TestManifest:
    def test_declares_exactly_the_capability_it_uses(self):
        from openrappter.agents.brainstem_agent import __manifest__

        assert __manifest__["schema"] == "rapp-agent/1.0"
        assert __manifest__["name"] == "@openrappter/brainstem"
        # Reading the address from the environment would add credential-access
        # to this list, and an agent claiming credential access to look up a
        # port number teaches an operator to ignore the manifest.
        assert __manifest__["capabilities"] == ["network"]


class TestRefusals:
    def test_asks_for_a_question_rather_than_sending_an_empty_one(self, agent):
        assert "No question given" in agent.perform(message="   ")

    def test_says_where_it_looked_when_no_brainstem_answers(self, agent, monkeypatch):
        def refuse(url, method, body):
            raise OSError("connection refused")

        install_urlopen(monkeypatch, refuse)
        out = agent.perform(message="hello")

        # Actionable: the two addresses tried, and the command that starts one.
        for candidate in CANDIDATE_URLS:
            assert candidate in out
        assert "python -m openrappter.brainstem" in out

    def test_refuses_json_that_is_not_a_chat_envelope(self, agent, monkeypatch):
        # Something answering on that port is not the same as the brainstem
        # answering; passing its words back as the brainstem's is the worst
        # outcome available here.
        install_urlopen(monkeypatch, healthy_then({"ok": True, "service": "something-else"}))
        out = agent.perform(message="hello")

        assert "not a chat envelope" in out

    def test_refuses_a_body_that_is_not_json(self, agent, monkeypatch):
        install_urlopen(monkeypatch, healthy_then("<html>proxy error</html>"))
        assert "not JSON" in agent.perform(message="hello")


class TestSuccess:
    def test_returns_the_brainstem_answer_with_attribution(self, agent, monkeypatch):
        install_urlopen(monkeypatch, healthy_then(ENVELOPE))
        out = agent.perform(message="hello")

        assert "Hello from the brainstem." in out
        # Which brain and which model, because the reply is otherwise
        # indistinguishable from this runtime's own.
        assert "claude-opus-4.6" in out
        assert "session-1" in out

    def test_sends_both_message_and_user_input(self, agent, monkeypatch):
        # The kernel this mirrors requires `user_input` and answers
        # `400 {"error":"user_input is required"}` without it. The docs call it
        # a legacy alias, so a test written from the documentation would miss
        # this and only a live brainstem would show it.
        calls = install_urlopen(monkeypatch, healthy_then(ENVELOPE))
        agent.perform(message="hello")

        chat = [c for c in calls if c["url"].endswith("/chat")][0]
        assert chat["body"]["message"] == "hello"
        assert chat["body"]["user_input"] == "hello"

    def test_carries_a_session_so_follow_ups_continue(self, agent, monkeypatch):
        calls = install_urlopen(monkeypatch, healthy_then(ENVELOPE))
        agent.perform(message="hello", session_id="abc")

        chat = [c for c in calls if c["url"].endswith("/chat")][0]
        assert chat["body"]["session_id"] == "abc"

    def test_omits_the_session_when_there_is_not_one(self, agent, monkeypatch):
        calls = install_urlopen(monkeypatch, healthy_then(ENVELOPE))
        agent.perform(message="hello")

        chat = [c for c in calls if c["url"].endswith("/chat")][0]
        assert "session_id" not in chat["body"]


class TestDiscovery:
    def test_finds_a_brainstem_in_the_rapp_drop_in_slot(self, agent, monkeypatch):
        # The installation this was written against has nothing on 7072 and a
        # real brainstem on 7071, so a single hardcoded address would make the
        # agent look broken there.
        def handler(url, method, body):
            if "7072" in url:
                raise OSError("connection refused")
            if url.endswith("/health"):
                return FakeResponse('{"status":"ok"}')
            return FakeResponse(json.dumps(ENVELOPE))

        install_urlopen(monkeypatch, handler)
        out = agent.perform(message="hello")

        assert "127.0.0.1:7071" in out
        assert "Hello from the brainstem." in out

    def test_an_explicit_address_is_used_without_probing(self, agent, monkeypatch):
        calls = install_urlopen(monkeypatch, healthy_then(ENVELOPE))
        agent.perform(message="hello", base_url="http://127.0.0.1:9999/")

        # If someone says where it is, probing elsewhere and quietly using a
        # different brainstem would be worse than failing.
        assert [c for c in calls if c["url"].endswith("/health")] == []
        assert calls[0]["url"] == "http://127.0.0.1:9999/chat"
