"""Pinning tests for the LOCAL-ONLY security/robustness hardening pass.

Each test guards one audited fix so it can't silently regress. Hermetic: no network,
no real token, and no repo state files touched (the LAN secret is injected in-memory;
the single voice.zip round-trip creates + removes its own artifact).

    python3 -m pytest tests/test_security_hardening.py -v
"""
import json
import os

import pytest
from unittest import mock

import brainstem as bs


@pytest.fixture
def client():
    return bs.app.test_client()


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


class _FakeExchangeResp:
    """Stand-in for the Copilot token-exchange response — its body carries a token."""
    def __init__(self, status=200):
        self.status_code = status
        self.text = ('{"token":"tid=LEAKED_COPILOT_TOKEN_XYZ;exp=9999999999;sku=free",'
                     '"expires_at":9999999999,"endpoints":{"api":"https://api.example"}}')

    def raise_for_status(self):
        pass

    def json(self):
        return json.loads(self.text)


# ── #1 CRITICAL: /debug/auth must not leak a token, and is loopback-only ───────

def test_debug_auth_never_returns_token_body(client, monkeypatch):
    monkeypatch.setattr(bs, "get_github_token", lambda: "ghu_faketoken1234567890")  # rapp-keyring: allow synthetic fixture — this value exists to prove it gets redacted
    monkeypatch.setattr(bs, "_read_token_file", lambda: {"access_token": "ghu_x", "refresh_token": "r"})
    monkeypatch.setattr(bs, "_load_copilot_cache", lambda github_token=None: None)
    monkeypatch.setattr(bs, "_exchange_github_for_copilot", lambda t: _FakeExchangeResp(200))

    r = client.get("/debug/auth")  # test_client default remote_addr is 127.0.0.1 (loopback)
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    data = r.get_json()
    # The live token from the exchange body must NEVER appear anywhere in the response.
    assert "LEAKED_COPILOT_TOKEN_XYZ" not in body
    assert "exchange_response" not in data          # the leaking key is gone
    assert data.get("exchange_http_status") == 200  # only status/booleans remain
    assert data.get("exchange_ok") is True


def test_debug_auth_forbidden_from_non_loopback(client, monkeypatch):
    # Guard against it even attempting an exchange for a remote caller.
    called = {"exchange": False}

    def _boom(_t):
        called["exchange"] = True
        return _FakeExchangeResp(200)

    monkeypatch.setattr(bs, "get_github_token", lambda: "ghu_faketoken1234567890")  # rapp-keyring: allow synthetic fixture — this value exists to prove it gets redacted
    monkeypatch.setattr(bs, "_exchange_github_for_copilot", _boom)

    r = client.get("/debug/auth", environ_overrides={"REMOTE_ADDR": "10.0.0.42"})
    assert r.status_code == 403
    assert r.is_json and "error" in r.get_json()
    body = r.get_data(as_text=True)
    assert "LEAKED_COPILOT_TOKEN_XYZ" not in body
    assert called["exchange"] is False  # never even ran the exchange


# ── #2 HIGH: token/exchange body is scrubbed before logging ────────────────────

def test_scrub_secrets_redacts_json_token_and_bearer():
    body = ('{"token":"tid=SECRET_ABC;exp=1","expires_at":1,'
            '"endpoints":{"api":"https://ep.example"}}')
    out = bs._scrub_secrets(body)
    assert "SECRET_ABC" not in out
    assert "REDACTED" in out
    assert "https://ep.example" in out  # non-secret fields preserved

    raw = "Authorization: Bearer abc.def.ghijklmnop trailing"
    out2 = bs._scrub_secrets(raw)
    assert "abc.def.ghijklmnop" not in out2 and "REDACTED" in out2

    quoted = 'Authorization: "Bearer QUOTED_AUTH_SECRET"'
    out3 = bs._scrub_secrets(quoted)
    assert "QUOTED_AUTH_SECRET" not in out3 and "REDACTED" in out3


def test_diagnostics_report_scrubs_all_published_content(client, monkeypatch):
    monkeypatch.setattr(bs, "_tlog_save", lambda: None)
    monkeypatch.setattr(bs, "load_agents", lambda: {})
    monkeypatch.setattr(
        bs.requests, "post",
        lambda *args, **kwargs: pytest.fail("Get Help must not create an issue"),
    )
    monkeypatch.setattr(bs, "_flight_log", [{
        "ts": "2026-07-09T00:00:00+00:00",
        "type": "api.error",
        "level": "error",
        "data": {
            "detail": {"authorization": "SERVER_AUTH_SECRET"},
            "response_body": (
                '{"token":"ENCODED_BODY_SECRET",'
                '"device_code":"ENCODED_DEVICE_SECRET"}'
            ),
            "api_key": "SERVER_API_SECRET",
            "email": "person@example.com",
            "remote": "192.168.1.20",
            "path": str(bs._BASE_DIR),
        },
    }])

    response = client.post("/diagnostics/report", json={
        "description": (
            "Failure with Bearer DESCRIPTION_SECRET "
            "password=DESCRIPTION_PASSWORD_SECRET"
        ),
        "client_events": [{
            "type": "client.error",
            "data": {"nested": {"password": "CLIENT_PASSWORD_SECRET"}},
            "session_id": "CLIENT_SESSION_SECRET",
        }],
    })

    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "draft"
    assert data["issue_url"].startswith(
        "https://github.com/microsoft/aibast-agents-library/issues/new?"
    )
    from urllib.parse import parse_qs, urlsplit
    draft = parse_qs(urlsplit(data["issue_url"]).query)
    issue_body = draft["body"][0]
    assert len(draft["title"]) == 1
    assert draft["title"][0].endswith(f" - v{bs.VERSION}")
    assert draft["title"][0].removesuffix(f" - v{bs.VERSION}").strip()
    for secret in (
        "SERVER_AUTH_SECRET",
        "SERVER_API_SECRET",
        "ENCODED_BODY_SECRET",
        "ENCODED_DEVICE_SECRET",
        "DESCRIPTION_SECRET",
        "DESCRIPTION_PASSWORD_SECRET",
        "CLIENT_PASSWORD_SECRET",
        "CLIENT_SESSION_SECRET",
    ):
        assert secret not in issue_body
    assert "REDACTED" in issue_body
    assert "github_token" not in issue_body
    assert "person@example.com" not in issue_body
    assert "192.168.1.20" not in issue_body
    assert str(bs._BASE_DIR) not in issue_body
    assert "<BRAINSTEM_DIR>" in issue_body

    form_response = client.post(
        "/diagnostics/report",
        data={"client_events": json.dumps([{"type": "client.click"}])},
        follow_redirects=False,
    )
    assert form_response.status_code == 303
    assert form_response.headers["Location"].startswith(
        "https://github.com/microsoft/aibast-agents-library/issues/new?"
    )


def test_support_report_synthesis_uses_scrubbed_transcript_without_tools(monkeypatch):
    captured = {}

    def fake_call(messages, tools=None):
        captured["messages"] = messages
        captured["tools"] = tools
        return ({
            "choices": [{"message": {"content": json.dumps({
                "title": "Chat reports connected with expired credentials",
                "report": (
                    "## Summary\n\nConnected state is misleading.\n\n"
                    "## What Happened\n\nThe UI showed connected after auth failed.\n\n"
                    "## Expected Behavior\n\nShow sign in.\n\n"
                    "## Actual Behavior\n\nShowed connected.\n\n"
                    "## Reproduction Steps\n\n1. Start with an expired credential.\n\n"
                    "## Relevant Context\n\nObserved during startup."
                ),
            })}}]}, bs.MODEL)

    monkeypatch.setattr(bs, "call_copilot", fake_call)
    transcript, error = bs._normalize_support_transcript([
        {
            "role": "user",
            "content": (
                "My email person@example.com failed at "
                "C:\\Users\\Example\\secret.txt?token=RAW_SECRET"
            ),
        },
        {"role": "assistant", "content": "Connected despite 192.168.1.20 failure."},
    ])
    assert error is None

    title, report = bs._synthesize_support_report(transcript, "_No warnings_")

    assert captured["tools"] is None
    evidence = json.dumps(captured["messages"])
    for private in (
        "person@example.com", "C:\\Users\\Example", "RAW_SECRET", "192.168.1.20",
    ):
        assert private not in evidence
    assert title == "Chat reports connected with expired credentials"
    assert "## Reproduction Steps" in report


def test_support_report_synthesis_falls_back_on_invalid_model_output(monkeypatch):
    monkeypatch.setattr(bs, "call_copilot", lambda messages, tools=None: (
        {"choices": [{"message": {"content": "not json"}}]}, bs.MODEL
    ))

    title, report = bs._synthesize_support_report(
        [{"role": "user", "content": "The send button stayed red."}],
        "_No warnings_",
    )

    assert title == "Brainstem help request"
    assert "## Reproduction Steps" in report
    assert "The send button stayed red." in report


def test_exchange_2xx_logs_status_only(monkeypatch, capsys):
    # A successful exchange must log only the status — never the (token-bearing) body.
    monkeypatch.setattr(bs.requests, "get", lambda *a, **k: _FakeExchangeResp(200))
    bs._exchange_github_for_copilot("ghu_faketoken1234567890")  # rapp-keyring: allow synthetic fixture — this value exists to prove it gets redacted
    printed = capsys.readouterr().out
    assert "LEAKED_COPILOT_TOKEN_XYZ" not in printed
    assert "HTTP 200 (ok)" in printed


# ── #3 CRITICAL: LAN mutating routes require the secret; loopback is exempt ─────

MUTATING = [
    ("post", "/agents/import"),
    ("post", "/voice/import"),
    ("delete", "/agents/basic_agent.py"),
]


@pytest.mark.parametrize("method,path", MUTATING)
def test_mutating_route_loopback_exempt(client, method, path):
    # Loopback (same-machine UI) must reach the handler WITHOUT any secret. We send no
    # file / target the undeletable base class, so the handler short-circuits with a
    # 4xx that is NOT 403 — proving the gate let it through without side effects.
    r = getattr(client, method)(path)
    assert r.status_code != 403


@pytest.mark.parametrize("method,path", MUTATING)
def test_mutating_route_blocks_lan_without_secret(client, monkeypatch, method, path):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = getattr(client, method)(path, environ_overrides={"REMOTE_ADDR": "192.168.1.50"})
    assert r.status_code == 403
    assert r.is_json and "error" in r.get_json()


@pytest.mark.parametrize("method,path", MUTATING)
def test_mutating_route_allows_lan_with_secret(client, monkeypatch, method, path):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = getattr(client, method)(
        path,
        headers={"X-Brainstem-Secret": "unit-test-secret"},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code != 403  # gate passed → handler ran (returns its own 4xx)


def test_mutating_route_rejects_wrong_secret(client, monkeypatch):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.post(
        "/agents/import",
        headers={"X-Brainstem-Secret": "WRONG"},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code == 403


def test_basic_agent_survives_lan_delete_attempt_with_secret(client, monkeypatch):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.delete(
        "/agents/basic_agent.py",
        headers={"X-Brainstem-Secret": "unit-test-secret"},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code == 400  # gate passed, handler refuses to delete the base class
    assert os.path.exists(os.path.join(bs._BASE_DIR, "agents", "basic_agent.py"))


# ── #3c CORS restricted to localhost origins ───────────────────────────────────

def test_cors_allows_localhost_blocks_other_origins(client):
    ok = client.get("/version", headers={"Origin": "http://localhost:7071"})
    assert ok.headers.get("Access-Control-Allow-Origin") == "http://localhost:7071"
    bad = client.get("/version", headers={"Origin": "http://evil.example.com"})
    assert bad.headers.get("Access-Control-Allow-Origin") is None


@pytest.mark.parametrize("origin", [
    "https://microsoft.github.io",
    "https://kody-w.github.io",
])
def test_public_health_allows_trusted_library_without_secret(
    client,
    monkeypatch,
    origin,
):
    def unexpected_secret_load():
        raise AssertionError("public health must not load the LAN secret")

    monkeypatch.setattr(bs, "_load_or_create_secret", unexpected_secret_load)
    r = client.get(
        "/health/public",
        headers={"Origin": origin, "Sec-Fetch-Site": "cross-site"},
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )

    assert r.status_code == 200
    assert r.get_json() == {"status": "ok", "version": bs.VERSION}
    assert r.headers.get("Access-Control-Allow-Origin") == origin


def test_public_health_does_not_allow_untrusted_origin_to_read(client):
    r = client.get(
        "/health/public",
        headers={
            "Origin": "https://attacker.example",
            "Sec-Fetch-Site": "cross-site",
        },
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )

    assert r.status_code == 200
    assert r.headers.get("Access-Control-Allow-Origin") is None
    assert set(r.get_json()) == {"status", "version"}


def test_foreign_origin_cannot_post_to_loopback(client, monkeypatch):
    called = {"chat": False}

    def fake_load_agents():
        called["chat"] = True
        return {}

    monkeypatch.setattr(bs, "load_agents", fake_load_agents)
    r = client.post(
        "/chat",
        data=json.dumps({"user_input": "run something"}),
        content_type="text/plain",
        headers={"Origin": "https://evil.example"},
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )
    assert r.status_code == 403 and r.is_json
    assert called["chat"] is False


def test_management_route_blocks_lan_without_secret(client, monkeypatch):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.post(
        "/voice/toggle",
        json={"enabled": True},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code == 403


@pytest.mark.parametrize("path", [
    "/agents",
    "/agents/export/basic_agent.py",
    "/diagnostics",
    "/diagnostics/book.json",
    "/login/status",
])
def test_sensitive_reads_block_lan_without_secret(client, monkeypatch, path):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.get(path, environ_overrides={"REMOTE_ADDR": "192.168.1.50"})
    assert r.status_code == 403


def test_cross_site_sensitive_get_blocked_on_loopback(client, monkeypatch):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.get(
        "/agents",
        headers={"Sec-Fetch-Site": "cross-site"},
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )
    assert r.status_code == 403


@pytest.mark.parametrize("path", ["/chat", "/chat/stream"])
def test_chat_routes_block_lan_without_secret(client, monkeypatch, path):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.post(
        path,
        json={"user_input": ""},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code == 403


@pytest.mark.parametrize("path", ["/chat", "/chat/stream"])
def test_chat_routes_allow_lan_with_secret(client, monkeypatch, path):
    monkeypatch.setattr(bs, "BRAINSTEM_SECRET", "unit-test-secret")
    r = client.post(
        path,
        json={"user_input": ""},
        headers={"X-Brainstem-Secret": "unit-test-secret"},
        environ_overrides={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert r.status_code == 400


def test_matching_untrusted_host_and_origin_are_rejected(client):
    r = client.get(
        "/diagnostics",
        headers={"Host": "attacker.example", "Origin": "http://attacker.example"},
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )
    assert r.status_code == 400


def test_stream_get_is_method_not_allowed(client):
    r = client.get("/chat/stream")
    assert r.status_code == 405


def test_agent_import_rejects_digest_mismatch(client, monkeypatch, tmp_path):
    from io import BytesIO

    monkeypatch.setattr(bs, "AGENTS_PATH", str(tmp_path))
    r = client.post(
        "/agents/import",
        data={
            "file": (BytesIO(b"print('untrusted')\n"), "catalog_agent.py"),
            "sha256": "0" * 64,
            "source_revision": bs.RAR_REVISION,
        },
        content_type="multipart/form-data",
    )
    assert r.status_code == 400
    assert "integrity" in r.get_json()["error"].lower()
    assert not (tmp_path / "catalog_agent.py").exists()


# ── #4 MEDIUM: request size cap configured ─────────────────────────────────────

def test_max_content_length_configured():
    assert bs.app.config.get("MAX_CONTENT_LENGTH") == 16 * 1024 * 1024


# ── #6 MEDIUM: voice password via header, not query string ─────────────────────

def test_voice_config_uses_header_password_not_query(client, monkeypatch):
    import pyzipper
    voice_zip = os.path.join(bs._BASE_DIR, "voice.zip")
    assert not os.path.exists(voice_zip), "test would clobber a real voice.zip"
    monkeypatch.setattr(bs, "VOICE_ZIP_PW", None)  # deterministic: no env default
    try:
        with pyzipper.AESZipFile(voice_zip, "w",
                                 compression=pyzipper.ZIP_DEFLATED,
                                 encryption=pyzipper.WZ_AES) as zf:
            zf.setpassword(b"pw123")
            zf.writestr("voice.json", json.dumps({"greeting": "hi"}))

        # Correct password via the HEADER → config is returned.
        ok = client.get("/voice/config", headers={"X-Voice-Password": "pw123"})
        assert ok.status_code == 200 and ok.get_json() == {"greeting": "hi"}

        # Same password via the QUERY STRING (no header) → ignored → cannot decrypt.
        bad = client.get("/voice/config?password=pw123")
        assert bad.status_code != 200 or bad.get_json() != {"greeting": "hi"}
    finally:
        if os.path.exists(voice_zip):
            os.remove(voice_zip)


# ── #7 MEDIUM: streaming surfaces NO_COPILOT_ACCESS as a structured event ───────

def test_stream_surfaces_no_copilot_access_structured(client):
    def fake_stream(*a, **k):
        raise RuntimeError("NO_COPILOT_ACCESS:octo@example.com")
        yield  # pragma: no cover — makes this a generator, like the real one

    with mock.patch.object(bs, "load_soul", return_value="SOUL"), \
         mock.patch.object(bs, "load_agents", return_value={}), \
         mock.patch.object(bs, "call_copilot_stream", side_effect=fake_stream), \
         mock.patch.object(bs, "call_copilot",
                           side_effect=RuntimeError("NO_COPILOT_ACCESS:octo@example.com")):
        resp = client.post("/chat/stream", json={"user_input": "hi"})
        events = _parse_sse(resp.get_data(as_text=True))

    errs = [e for e in events if e.get("type") == "error"]
    assert errs, f"expected an error event, got: {events}"
    e = errs[-1]
    assert e.get("no_copilot_access") is True
    assert e.get("copilot_username") == "octo@example.com"
    assert e.get("error", "").startswith("NO_COPILOT_ACCESS:")


def test_stream_disconnect_deterministically_closes_inner_generator(client):
    state = {"closed": False}
    holder = {}

    def inner():
        try:
            for i in range(5):
                yield ("delta", "c%d " % i)
            yield ("done", {"message": {"role": "assistant", "content": "x"},
                            "model": "gpt-4o", "finish_reason": "stop"})
        finally:
            state["closed"] = True

    def fake_stream(*a, **k):
        g = inner()
        holder["gen"] = g  # a strong ref defeats refcount-GC auto-close of the inner gen
        return g

    with mock.patch.object(bs, "load_soul", return_value="SOUL"), \
         mock.patch.object(bs, "load_agents", return_value={}), \
         mock.patch.object(bs, "call_copilot_stream", side_effect=fake_stream):
        resp = client.post("/chat/stream", json={"user_input": "hi"})
        it = resp.response
        next(it)  # pull one delta → outer generator suspended mid inner-stream
        assert state["closed"] is False
        resp.close()  # simulate client disconnect
    # Even though `holder` keeps the inner generator alive, the outer generator's
    # explicit .close() in finally must have closed it (its finally ran).
    assert state["closed"] is True


# ── #8 LOW: bad request bodies yield JSON 400, never Werkzeug HTML ──────────────

def test_models_set_malformed_json_is_json_400(client):
    r = client.post("/models/set", data="{ not json", content_type="application/json")
    assert r.status_code == 400 and r.is_json and "error" in r.get_json()


def test_models_set_non_string_model_is_json_400(client):
    r = client.post("/models/set", json={"model": 7})
    assert r.status_code == 400 and r.get_json()["error"] == "model must be a string"


def test_voice_config_save_non_object_json_is_json_400(client):
    r = client.post("/voice/config", json=[1, 2, 3])
    assert r.status_code == 400 and r.is_json and "error" in r.get_json()


@pytest.mark.parametrize("path", ["/voice/config", "/voice/export"])
def test_voice_export_password_must_be_a_string(client, path):
    r = client.post(path, json={"_password": 123})
    assert r.status_code == 400 and r.is_json and "Password required" in r.get_json()["error"]


def test_voice_toggle_empty_body_toggles_not_error(client):
    before = bs.VOICE_MODE
    try:
        r = client.post("/voice/toggle")  # no body at all
        assert r.status_code == 200 and r.is_json
        assert r.get_json()["voice_mode"] == (not before)
    finally:
        bs.VOICE_MODE = before


def test_voice_toggle_rejects_string_boolean_without_changing_state(client):
    before = bs.VOICE_MODE
    r = client.post("/voice/toggle", json={"enabled": "false"})
    assert r.status_code == 400
    assert r.get_json()["error"] == "enabled must be a boolean"
    assert bs.VOICE_MODE is before


def test_voice_import_rejects_oversized_uncompressed_config(client, monkeypatch):
    from io import BytesIO
    import pyzipper

    archive = BytesIO()
    with pyzipper.AESZipFile(
            archive, "w", compression=pyzipper.ZIP_DEFLATED,
            encryption=pyzipper.WZ_AES) as zf:
        zf.setpassword(b"pw")
        zf.writestr("voice.json", json.dumps({"padding": "x" * 1024}))
    archive.seek(0)
    monkeypatch.setattr(bs, "_MAX_VOICE_CONFIG_BYTES", 64)

    voice_zip = os.path.join(bs._BASE_DIR, "voice.zip")
    assert not os.path.exists(voice_zip), "test would clobber a real voice.zip"
    response = client.post(
        "/voice/import",
        data={"password": "pw", "file": (archive, "voice.zip")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 413
    assert "too large" in response.get_json()["error"]
    assert not os.path.exists(voice_zip)


@pytest.mark.parametrize("path", ["/voice/config", "/voice/export"])
def test_voice_writers_reject_configs_the_readers_cannot_open(client, monkeypatch, path):
    monkeypatch.setattr(bs, "_MAX_VOICE_CONFIG_BYTES", 64)
    voice_zip = os.path.join(bs._BASE_DIR, "voice.zip")
    assert not os.path.exists(voice_zip), "test would clobber a real voice.zip"

    response = client.post(path, json={"_password": "pw", "padding": "x" * 1024})

    assert response.status_code == 413
    assert "too large" in response.get_json()["error"]
    assert not os.path.exists(voice_zip)


def test_agent_import_rejects_cross_file_name_collision_and_rolls_back(client, monkeypatch, tmp_path):
    from io import BytesIO

    def agent_source(class_name, result):
        return f'''from agents.basic_agent import BasicAgent
class {class_name}(BasicAgent):
    def __init__(self):
        self.name = "SharedName"
        self.metadata = {{"name": self.name, "description": "test", "parameters": {{"type": "object", "properties": {{}}}}}}
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return {result!r}
'''.encode()

    existing = tmp_path / "a_agent.py"
    existing.write_bytes(agent_source("FirstAgent", "first"))
    monkeypatch.setattr(bs, "AGENTS_PATH", str(tmp_path))

    response = client.post(
        "/agents/import",
        data={"file": (BytesIO(agent_source("SecondAgent", "second")), "b_agent.py")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 409
    assert "conflicts" in response.get_json()["error"]
    assert existing.exists()
    assert not (tmp_path / "b_agent.py").exists()


def test_agent_import_restores_previous_file_when_replacement_cannot_load(client, monkeypatch, tmp_path):
    from io import BytesIO

    previous = b'''from agents.basic_agent import BasicAgent
class ExistingAgent(BasicAgent):
    def __init__(self):
        self.name = "Existing"
        self.metadata = {"name": self.name, "description": "test", "parameters": {"type": "object", "properties": {}}}
        super().__init__(name=self.name, metadata=self.metadata)
    def perform(self, **kwargs):
        return "ok"
'''
    path = tmp_path / "existing_agent.py"
    path.write_bytes(previous)
    monkeypatch.setattr(bs, "AGENTS_PATH", str(tmp_path))

    response = client.post(
        "/agents/import",
        data={"file": (BytesIO(b"this is not valid Python"), "existing_agent.py")},
        content_type="multipart/form-data",
    )

    assert response.status_code == 200
    assert "previous installation was preserved" in response.get_json()["error"]
    assert path.read_bytes() == previous
