"""OpenRappter Brainstem — wire parity with the RAPP brainstem kernel.

The brainstem is the local-device-first rappter: same routes, same JSON
envelopes, same agent contract as rapp_brainstem/brainstem.py, so training
against either transfers to the other. These tests exercise the real HTTP
server (stdlib ThreadingHTTPServer on an ephemeral port) — the wire IS the
contract. Stdlib-only, like the brainstem itself.
"""

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from openrappter import brainstem


RAPP_STYLE_AGENT = '''
from agents.basic_agent import BasicAgent

class DropInAgent(BasicAgent):
    def __init__(self):
        self.name = 'DropIn'
        self.metadata = {
            "name": self.name,
            "description": "A RAPP-authored agent dropped into the OpenRappter brainstem.",
            "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": []},
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return '{"status": "success", "echo": "%s"}' % kwargs.get("query", "")
'''


# ── tiny stdlib HTTP client ──

def http(method, url, body=None, headers=None):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def get_json(url):
    status, body = http("GET", url)
    return status, json.loads(body)


def post_json(url, payload):
    status, body = http("POST", url, json.dumps(payload).encode(), {"Content-Type": "application/json"})
    return status, json.loads(body)


def post_multipart(url, filename, content):
    boundary = "----openrappterboundary"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: text/x-python\r\n\r\n"
        f"{content}\r\n"
        f"--{boundary}--\r\n"
    ).encode()
    status, resp = http("POST", url, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return status, json.loads(resp)


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    monkeypatch.setattr(brainstem, "AGENTS_PATH", tmp_path / "agents")
    monkeypatch.setattr(brainstem, "SOUL_PATH", tmp_path / "soul.md")
    # Keep tests hermetic: never reach for a real GitHub token
    monkeypatch.setattr(brainstem, "_github_token", lambda: None)
    (tmp_path / "agents").mkdir()

    httpd = brainstem.serve(port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield base
    httpd.shutdown()


def test_health_envelope_matches_kernel_shape(server):
    status, health = get_json(f"{server}/health")
    assert status == 200
    for key in ("status", "version", "agents", "brainstem_dir", "soul", "model", "copilot"):
        assert key in health, f"kernel /health envelope missing {key}"
    assert health["status"] == "ok"
    # Packaged OpenRappter agents form the default pool
    assert len(health["agents"]) >= 10


def test_version_and_models(server):
    assert "version" in get_json(f"{server}/version")[1]
    _, models = get_json(f"{server}/models")
    assert models["active"] in models["models"]


def test_local_storage_shim_supports_current_rapp_memory_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    storage = brainstem.LocalStorageManager()
    assert storage.current_guid is None
    storage.set_memory_context("user-one")
    assert storage.current_guid == "user-one"
    assert storage.update_json(lambda data: {**data, "fact": "remembered"}) == {
        "fact": "remembered"
    }
    assert storage.read_json() == {"fact": "remembered"}


def test_rapp_authored_agent_drops_in(server, tmp_path):
    """The training-parity proof: an agent written for the RAPP kernel
    (importing agents.basic_agent) hot-loads here unchanged."""
    (tmp_path / "agents" / "drop_in_agent.py").write_text(RAPP_STYLE_AGENT)
    _, health = get_json(f"{server}/health")
    assert "DropIn" in health["agents"]


def test_agents_import_export_delete_roundtrip(server):
    _, imported = post_multipart(f"{server}/agents/import", "roundtrip_agent.py", RAPP_STYLE_AGENT)
    assert imported.get("status") == "ok", imported

    _, listing = get_json(f"{server}/agents")
    entry = next(f for f in listing["files"] if f["filename"] == "roundtrip_agent.py")
    assert entry["agents"] == ["DropIn"]

    status, body = http("GET", f"{server}/agents/export/roundtrip_agent.py")
    assert status == 200 and b"class DropInAgent" in body

    status, deleted = http("DELETE", f"{server}/agents/roundtrip_agent.py")
    assert json.loads(deleted)["status"] == "ok"
    assert http("GET", f"{server}/agents/export/roundtrip_agent.py")[0] == 404


def test_import_renames_to_agent_suffix_and_rejects_non_python(server):
    _, result = post_multipart(f"{server}/agents/import", "thing.py", RAPP_STYLE_AGENT)
    assert "thing_agent.py" in result.get("message", "")

    _, rejected = post_multipart(f"{server}/agents/import", "notes.txt", "hello")
    assert "error" in rejected


def test_chat_validates_input_like_the_kernel(server):
    assert post_json(f"{server}/chat", {})[0] == 400
    status, _ = http("POST", f"{server}/chat", b"not json", {"Content-Type": "application/json"})
    assert status == 400
    status, body = post_json(f"{server}/chat", {"user_input": "   "})
    assert status == 400
    assert body["error"] == "message is required"


def test_rapp_chat_v1_contract(server, monkeypatch):
    contract = json.loads(
        (Path(__file__).parents[2] / "contracts" / "rapp-chat-v1.json").read_text()
    )
    assert contract["brand"] == "RAPP + X™"
    monkeypatch.setattr(
        brainstem,
        "llm_chat",
        lambda _messages, _tools: {"role": "assistant", "content": "canonical"},
    )
    status, body = post_json(f"{server}/chat", {
        "schema": "rapp-chat/1.0",
        "message": "hello",
        "session_id": "shared-session",
        "idempotency_key": "shared-idempotency",
        "conversation_history": [],
    })
    assert status == 200
    assert body["schema"] == "rapp-chat/1.0"
    assert body["status"] == "success"
    assert body["response"] == body["content"] == "canonical"
    assert body["session_id"] == body["sessionId"] == "shared-session"
    assert body["idempotency_key"] == "shared-idempotency"


def test_rapp_chat_idempotency_prevents_duplicate_execution(server, monkeypatch):
    calls = {"count": 0}

    def fake_llm(_messages, _tools):
        calls["count"] += 1
        return {"role": "assistant", "content": "once"}

    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)
    payload = {
        "message": "run once",
        "session_id": "idempotent-session",
        "idempotency_key": "python-idempotency-once",
    }
    first_status, first = post_json(f"{server}/chat", payload)
    second_status, second = post_json(f"{server}/chat", payload)
    assert first_status == second_status == 200
    assert first == second
    assert calls["count"] == 1

    conflict_status, conflict = post_json(f"{server}/chat", {
        **payload,
        "message": "different",
    })
    assert conflict_status == 409
    assert conflict["status"] == "error"
    assert calls["count"] == 1

    generated_payload = {
        "message": "generate one session",
        "idempotency_key": "python-generated-session-once",
    }
    _, generated_first = post_json(f"{server}/chat", generated_payload)
    _, generated_second = post_json(f"{server}/chat", generated_payload)
    assert generated_first == generated_second
    assert generated_first["session_id"] == generated_second["session_id"]


def test_chat_tool_loop_executes_agents(server, tmp_path, monkeypatch):
    """Full /chat round: fake LLM asks for the DropIn tool, brainstem executes
    the real agent, LLM sees the result and answers."""
    (tmp_path / "agents" / "drop_in_agent.py").write_text(RAPP_STYLE_AGENT)

    calls = {"n": 0}

    def fake_llm(messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            assert any(t["function"]["name"] == "DropIn" for t in tools)
            return {"role": "assistant", "content": None, "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "DropIn", "arguments": json.dumps({"query": "ping"})}}]}
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        assert "ping" in tool_msgs[-1]["content"]
        return {"role": "assistant", "content": "DropIn echoed ping."}

    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)

    status, reply = post_json(f"{server}/chat", {"user_input": "use DropIn to echo ping"})
    assert status == 200
    assert reply["response"] == "DropIn echoed ping."
    assert "[DropIn]" in reply["agent_logs"]
    assert "ping" in reply["agent_logs"]


def test_chat_surfaces_llm_unavailability_as_json(server, monkeypatch):
    monkeypatch.setattr(brainstem, "copilot_session", lambda: None)
    status, body = post_json(f"{server}/chat", {"user_input": "hello"})
    assert status == 503
    assert "error" in body


def test_trusted_context_injects_only_authorized_memory(monkeypatch):
    captured = {}
    monkeypatch.setattr(brainstem, "load_agents", lambda: {})

    def fake_llm(messages, tools):
        captured["system"] = messages[0]["content"]
        captured["messages"] = messages
        return {"role": "assistant", "content": "safe"}

    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)
    result = brainstem.run_chat(
        "hello",
        [],
        "session",
        trusted_context={
            "trusted": True,
            "principal_id": "principal:person",
            "audience_id": "group:safe",
            "conversation_id": "group:safe",
            "conversation_type": "group",
            "participant_ids": ["principal:person"],
            "authorized_memory_data": [
                {"id": "safe", "message": "authorized group fact", "theme": "fact"}
            ],
            "familiarity": True,
        },
    )
    assert result["response"] == "safe"
    assert "authorized group fact" not in captured["system"]
    assert "authorized group fact" in captured["messages"][1]["content"]
    assert "familiarity: known" in captured["system"]


def test_runtime_overwrites_spoofed_memory_context(monkeypatch):
    captured = {}

    class MemoryAgent:
        name = "ManageMemory"
        metadata = {
            "description": "memory",
            "parameters": {"type": "object", "properties": {}},
        }

        def perform(self, **kwargs):
            captured["context"] = kwargs["_trusted_context"]
            return json.dumps({"status": "success"})

    calls = {"count": 0}

    def fake_llm(messages, tools):
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "memory-call",
                    "function": {
                        "name": "ManageMemory",
                        "arguments": json.dumps({
                            "action": "remember",
                            "content": "fact",
                            "_trusted_context": {"audience_id": "spoofed"},
                        }),
                    },
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(brainstem, "load_agents", lambda: {"ManageMemory": MemoryAgent()})
    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)
    trusted = {
        "trusted": True,
        "principal_id": "principal:verified",
        "audience_id": "dm:verified",
        "conversation_id": "dm:verified",
        "conversation_type": "dm",
        "participant_ids": ["principal:verified"],
    }
    assert brainstem.run_chat("remember", [], "session", trusted_context=trusted)["response"] == "done"
    assert captured["context"] == trusted


def test_non_owner_trusted_turn_exposes_only_allowed_agents(monkeypatch):
    captured = {}

    class Agent:
        def __init__(self, name):
            self.name = name
            self.metadata = {
                "description": name,
                "parameters": {"type": "object", "properties": {}},
            }

        def perform(self, **kwargs):
            return "ok"

    monkeypatch.setattr(
        brainstem,
        "load_agents",
        lambda: {
            "Shell": Agent("Shell"),
            "ManageMemory": Agent("ManageMemory"),
            "ContextMemory": Agent("ContextMemory"),
        },
    )

    def fake_llm(messages, tools):
        captured["tools"] = [tool["function"]["name"] for tool in tools]
        return {"role": "assistant", "content": "safe"}

    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)
    result = brainstem.run_chat(
        "hello",
        [],
        "session",
        trusted_context={
            "trusted": True,
            "principal_id": "principal:guest",
            "audience_id": "group:safe",
            "conversation_id": "group:safe",
            "conversation_type": "group",
            "participant_ids": ["principal:guest"],
            "is_owner": False,
            "allowed_agents": ["ManageMemory", "ContextMemory"],
        },
    )
    assert result["response"] == "safe"
    assert set(captured["tools"]) == {"ManageMemory", "ContextMemory"}
    assert "Shell" not in captured["tools"]


def test_normal_chat_strips_model_supplied_reserved_context(monkeypatch):
    captured = {}

    class MemoryAgent:
        name = "ManageMemory"
        metadata = {
            "description": "memory",
            "parameters": {"type": "object", "properties": {}},
        }

        def perform(self, **kwargs):
            captured.update(kwargs)
            return "ok"

    calls = {"count": 0}

    def fake_llm(messages, tools):
        calls["count"] += 1
        if calls["count"] == 1:
            return {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "spoof",
                    "function": {
                        "name": "ManageMemory",
                        "arguments": json.dumps({
                            "content": "fact",
                            "_trusted_context": {
                                "trusted": True,
                                "principal_id": "attacker",
                                "audience_id": "owner",
                            },
                        }),
                    },
                }],
            }
        return {"role": "assistant", "content": "done"}

    monkeypatch.setattr(brainstem, "load_agents", lambda: {"ManageMemory": MemoryAgent()})
    monkeypatch.setattr(brainstem, "llm_chat", fake_llm)
    assert brainstem.run_chat("hello", [], "session")["response"] == "done"
    assert "_trusted_context" not in captured


# ── Auth parity with the kernel's device-code flow ──


def test_device_login_flow_persists_token(server, tmp_path, monkeypatch):
    """POST /login starts the flow; /login/poll captures and persists the token
    in the kernel's JSON token-file format."""
    responses = iter([
        {"device_code": "dc123", "user_code": "ABCD-1234",
         "verification_uri": "https://github.com/login/device", "interval": 5, "expires_in": 900},
        {"error": "authorization_pending"},
        {"access_token": "ghu_testtoken123", "refresh_token": "ghr_refresh456"},
    ])
    monkeypatch.setattr(brainstem, "_http_form", lambda url, data, timeout=15: next(responses))

    status, started = post_json(f"{server}/login", {})
    assert status == 200
    assert started["user_code"] == "ABCD-1234"
    assert "verification_uri" in started

    _, pending = post_json(f"{server}/login/poll", {})
    assert pending["status"] == "pending"

    _, done = post_json(f"{server}/login/poll", {})
    assert done["status"] == "success"

    saved = json.loads((tmp_path / ".copilot_token").read_text())
    assert saved["access_token"] == "ghu_testtoken123"
    assert saved["refresh_token"] == "ghr_refresh456"


def test_login_status_envelope(server):
    _, status_body = get_json(f"{server}/login/status")
    assert set(status_body) >= {"authenticated", "pending", "token_file"}
    assert status_body["authenticated"] is False


def test_github_token_resolution_order(tmp_path, monkeypatch):
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    # 1. Saved token file (kernel JSON format) wins over gh CLI
    (tmp_path / ".copilot_token").write_text(json.dumps({"access_token": "ghu_fromfile"}))
    assert brainstem._github_token() == "ghu_fromfile"

    # 2. Legacy plain-text token file format still reads
    (tmp_path / ".copilot_token").write_text("ghu_legacyplain")
    assert brainstem._github_token() == "ghu_legacyplain"

    # 3. Env var wins over the file
    monkeypatch.setenv("GITHUB_TOKEN", "ghu_fromenv")
    assert brainstem._github_token() == "ghu_fromenv"


def test_gh_cli_gho_tokens_are_skipped(tmp_path, monkeypatch):
    """gho_ OAuth tokens 404 on the Copilot exchange — the kernel skips them
    and so do we."""
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)

    class FakeProc:
        returncode = 0
        stdout = "gho_clitoken\n"

    monkeypatch.setattr(brainstem.subprocess, "run", lambda *a, **k: FakeProc())
    assert brainstem._github_token() is None


def test_github_token_reuses_openrappter_consumer_profile(tmp_path, monkeypatch):
    brainstem_home = tmp_path / "brainstem"
    credentials = tmp_path / "credentials"
    credentials.mkdir()
    (credentials / "github-token.json").write_text(
        json.dumps({"token": "ghu_consumer_profile"})
    )
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", brainstem_home)
    monkeypatch.delenv("COPILOT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    assert brainstem._github_token() == "ghu_consumer_profile"


def test_copilot_session_uses_direct_capi_for_modern_oauth(monkeypatch):
    monkeypatch.setattr(brainstem, "_github_token", lambda: "gho_modern")
    monkeypatch.setattr(
        brainstem,
        "_http_json",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("modern OAuth must not use the legacy exchange")
        ),
    )
    brainstem._copilot_cache.update(
        {"token": None, "endpoint": None, "expires_at": 0}
    )
    session = brainstem.copilot_session()
    assert session["token"] == "gho_modern"
    assert session["direct_capi"] is True
    assert session["endpoint"] == "https://api.enterprise.githubcopilot.com"


def test_direct_capi_chat_uses_supported_model_and_body(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        brainstem,
        "copilot_session",
        lambda: {
            "token": "gho_modern",
            "endpoint": "https://api.enterprise.githubcopilot.com",
            "expires_at": 9999999999,
            "direct_capi": True,
        },
    )

    def fake_http(url, headers, payload=None, timeout=60):
        captured["url"] = url
        captured["payload"] = payload
        return 200, {
            "choices": [{"message": {"role": "assistant", "content": "ok"}}]
        }

    monkeypatch.setattr(brainstem, "_http_json", fake_http)
    reply = brainstem.llm_chat([{"role": "user", "content": "hello"}], [])
    assert reply["content"] == "ok"
    assert captured["url"].endswith("/chat/completions")
    assert captured["payload"]["model"] == "gpt-4o"
    assert "max_tokens" not in captured["payload"]


def test_copilot_session_refreshes_when_expired(tmp_path, monkeypatch):
    import time

    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    monkeypatch.setenv("GITHUB_TOKEN", "ghu_x")
    exchanges = {"n": 0}

    def fake_exchange(url, headers, payload=None, timeout=60):
        exchanges["n"] += 1
        return 200, {"token": f"cop_{exchanges['n']}",
                     "endpoints": {"api": "https://api.example"},
                     "expires_at": time.time() + 1800}

    monkeypatch.setattr(brainstem, "_http_json", fake_exchange)
    brainstem._copilot_cache.update({"token": None, "endpoint": None, "expires_at": 0})

    first = brainstem.copilot_session()
    assert first["token"] == "cop_1"
    # Warm cache: no second exchange
    assert brainstem.copilot_session()["token"] == "cop_1"
    assert exchanges["n"] == 1
    # Expire it (inside the 60s buffer) — next call re-exchanges
    brainstem._copilot_cache["expires_at"] = time.time() + 30
    assert brainstem.copilot_session()["token"] == "cop_2"
    assert exchanges["n"] == 2
    brainstem._copilot_cache.update({"token": None, "endpoint": None, "expires_at": 0})
