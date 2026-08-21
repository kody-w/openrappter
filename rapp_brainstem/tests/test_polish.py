"""
Regression tests for the pearl-polish pass. Each test guards one specific fix so it
can't silently regress. Hermetic: no network, no real token or state files touched.

    python3 -m pytest test_polish.py -v
"""
import json
import os
import re
import pytest

import brainstem as bs
import local_storage


# ── Security: the static route no longer serves the brainstem directory ────────

def test_static_route_does_not_serve_dotfiles_or_source():
    """Regression for the Flask static_folder leak: a GET of any brainstem file
    (.env with GITHUB_TOKEN, the token caches, the source) must NOT be served."""
    c = bs.app.test_client()
    for path in ("/rapp_brainstem/.env", "/rapp_brainstem/.copilot_token",
                 "/rapp_brainstem/.copilot_session", "/rapp_brainstem/brainstem.py",
                 "/static/.env", "/.env"):
        assert c.get(path).status_code == 404, f"{path} should not be served"


def test_index_html_still_served():
    r = bs.app.test_client().get("/")
    assert r.status_code == 200 and b"RAPP Brainstem" in r.data


# ── RAR browser fetches the primary registry and protects shared dependencies ─

def test_rar_fetch_uses_raw_github_before_mirror():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    helper = index[index.index("async function rarFetch"):index.index("let rarRegistry")]
    assert "fetch(encodeURI(`${RAR_BASE}/${path}`))" in helper
    assert "await rarFetch(path)" not in helper


def test_rar_browser_does_not_offer_basic_agent_for_install():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    helper = index[index.index("function isLoadableAgent"):index.index("function loadRarRegistry")]
    assert "base !== 'basic_agent.py'" in helper


def test_rar_browser_uses_collision_safe_install_filename():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    helper = index[index.index("async function installRarAgent"):index.index("async function copyDeviceCode")]
    assert "agent._install_filename ||" in helper
    assert "filename.includes('/')" in helper


def test_rar_browser_pins_and_verifies_catalog_agents():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    registry = index[index.index("const RAR_REVISION"):index.index("async function copyDeviceCode")]
    assert bs.RAR_REVISION in registry
    assert "RAR/main" not in registry and "RAR@main" not in registry
    assert "agent._sha256" in registry
    assert "crypto.subtle.digest('SHA-256'" in registry
    assert "actualDigest !== expectedDigest" in registry
    assert "This executes Python code on your machine" in registry


def test_stream_fallback_stops_after_response_is_accepted():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    send = index[index.index("async function sendMessage"):index.index("async function sendViaPost")]
    stream = index[index.index("async function sendViaStream"):index.index("// ── Voice")]
    assert "err.streamAccepted" in send
    assert "streamed = true" in send
    assert "responseAccepted = true" in stream
    assert "err.streamAccepted = true" in stream


def test_client_request_lifecycle_supports_concurrent_owned_replies():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    send = index[index.index("function handleSendButton"):index.index("// ── Voice")]
    actions = index[index.index("function clearChat"):index.index("// ══")]
    assert "const activeRequests = new Map()" in index
    assert "new AbortController()" in send
    assert "signal: requestState.controller.signal" in send
    assert "requestState.epoch !== conversationEpoch" in send
    assert "requestState.responseSlot" in send
    assert "userWrap.after(requestState.responseSlot)" in send
    assert "requestState.responseSlot.className = 'response-slot'" in send
    assert "requestState.responseSlot.appendChild(wrap)" in index
    assert "const inFlightTurns = new Set()" in send
    assert "cappedHistory(inFlightTurns)" in send
    assert ".filter(message => !excludedTurns?.has(message))" in index
    assert "appendTyping(requestState)" in send
    assert "insertReplyAfter(history, requestState.historyTurn" in index
    assert "fullTranscript, requestState.transcriptTurn, requestState.transcriptReply" in index.replace("\n", " ")
    assert "activeRequests.delete(requestState.id)" in send
    assert "activeRequest" not in index.replace("activeRequests", "")
    assert "requestState.controller.signal.aborted" in send
    assert "conversationEpoch += 1" in actions
    assert "cancelActiveRequests(true)" in actions


def test_send_stays_available_and_streamed_reply_fades_in_subtly():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    styles = index[index.index("#send {"):index.index(".toolbar-row {")]
    fade_styles = index[index.index(".msg.assistant.stream-arriving"):index.index(".typing {")]
    send = index[index.index("function handleSendButton"):index.index("function cancelActiveRequests")]
    stream = index[index.index("async function sendViaStream"):index.index("// ── Voice")]

    assert "min-width: 68px" in styles
    assert "#send.stop" not in styles
    assert "sendMessage();" in send
    assert "controller.abort()" not in send
    assert "stream-arriving" in fade_styles
    assert "bubble.stream-mask" in fade_styles
    assert "stream-message-coalesce 560ms" in fade_styles
    assert "--stream-reveal-y" in fade_styles
    assert "mask-image: linear-gradient" in fade_styles
    assert "assistant-arrive 360ms" in fade_styles
    assert "translateY(8px)" in fade_styles
    assert "prefers-reduced-motion: reduce" in fade_styles
    assert "animation: none; transform: none" in fade_styles
    assert "setTimeout(() =>" in stream and "}, 80)" in stream
    assert "buildStreamTree(assembled)" in stream
    assert "hasUnresolvedMarkdown(nextTree)" in stream
    assert "morphStreamChildren(bubbleEl, nextTree)" in stream
    assert "bubbleEl.classList.add('stream-mask')" in stream
    assert "lastRevealStartedAt = performance.now()" in stream
    assert "560 - (performance.now() - lastRevealStartedAt)" in stream
    assert "streaming-plain" not in index
    assert "stream-fade-tail" not in index
    assert "requestState.controller.signal.aborted" in stream
    assert "requestState.epoch !== conversationEpoch) return true" in stream
    assert "stream-caret" not in index
    assert "ac-pop" not in index
    assert "typeTick" not in stream


def test_version_disclaimer_combines_experimental_warning_and_accessible_mission():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    markup = index[index.index('<h1>RAPP Brainstem'):index.index('<div class="controls">')]
    styles = index[index.index(".version-disclaimer-wrap"):index.index(".toolbar-row {")]

    assert 'tabindex="0" aria-describedby="version-disclaimer"' in markup
    assert 'role="tooltip"' in markup
    assert "Experimental by design." in markup
    assert "AI can be incomplete or wrong" in markup
    assert "accessible to everyone, on a device they control" in markup
    assert ".version-disclaimer-wrap:hover .version-disclaimer" in styles
    assert ".version-disclaimer-wrap:focus-within .version-disclaimer" in styles
    assert "width: min(420px, calc(100vw - 28px))" in styles


def test_get_help_opens_privacy_scrubbed_public_draft_without_prompt_or_submission():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    helper = index[index.index("async function shareWithAdmin"):index.index("// ── Health / Auth")]

    assert "form.target = '_blank'" in helper
    assert "form.action = `${API}/diagnostics/report`" in helper
    assert "form.submit()" in helper
    assert "fullTranscript.slice(-16)" in helper
    assert "content: String(turn.content || '').slice(0, 2000)" in helper
    assert "prompt(" not in helper
    assert "GitHub issue draft opened with privacy-scrubbed diagnostics" in helper


def test_unauthenticated_health_clears_stale_connected_hint():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    health = index[index.index("async function checkHealth"):index.index("// Bias to connected")]
    unauthenticated = health[health.index("} else {"):]

    assert "statusText.textContent = 'sign in'" in unauthenticated
    assert "safeRemove('brainstem_auth')" in unauthenticated


def test_stream_entitlement_error_uses_structured_banner_path():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    send = index[index.index("async function sendMessage"):index.index("// ── Voice")]
    assert "evt.no_copilot_access" in send
    assert "err.noCopilotAccess" in send
    assert "appendNoCopilotMessage(err.copilotUsername, requestState.responseSlot)" in send


def test_mobile_long_responses_use_full_chat_width():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    assert "calc(100vw - 180px)" not in index
    assert ".msg.wide { width: 100%; max-width: 100%; }" in index


def test_chat_uses_normal_near_bottom_scrolling_without_first_exchange_repositioning():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    append = index[index.index("function appendMsg"):index.index("function appendTyping")]
    stream = index[index.index("async function sendViaStream"):index.index("// ── Voice")]

    assert "first-exchange-spacer" not in index
    assert "firstExchangeFocused" not in index
    assert "focusFirstExchange" not in index
    assert "conversationScrollGoal" not in index
    assert "chat.scrollHeight - chat.scrollTop - chat.clientHeight" in append
    assert "chat.scrollTop = chat.scrollHeight" in append
    assert "const goal = chat.scrollHeight - chat.clientHeight" in stream


def test_core_chat_controls_have_accessible_semantics():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    assert 'role="dialog" aria-modal="true"' in index
    assert 'id="chat" role="log" aria-live="polite"' in index
    assert 'id="model-select" aria-label="Model"' in index
    assert 'id="input" rows="1" aria-label="Message"' in index
    logs = index[index.index("if (logs)"):index.index("function appendTyping")]
    assert "document.createElement('button')" in logs
    assert "aria-expanded" in logs


def test_azure_speech_regions_are_validated_before_credentialed_requests():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    voice = index[index.index("// ── Voice (Azure Speech"):index.index("// ── Actions ──")]

    region_pattern = re.compile(r"^[a-z0-9]{2,32}$")
    assert region_pattern.fullmatch("uksouth")
    assert not region_pattern.fullmatch("attacker.example/path")
    assert "typeof value === 'string' && /^[a-z0-9]{2,32}$/.test(value)" in voice
    assert "function ensureAzureSpeechRegionOption(value)" in voice
    assert "isAzureSpeechRegion(cfg.azure_speech_region)" in voice
    assert voice.count("if (!isAzureSpeechRegion(") >= 2
    assert voice.index("if (!isAzureSpeechRegion(region))") < voice.index(
        "https://${region}.tts.speech.microsoft.com")
    assert voice.index("if (!isAzureSpeechRegion(azSpeechRegion))") < voice.index(
        "https://${azSpeechRegion}.tts.speech.microsoft.com")


def test_markdown_images_render_as_click_only_links():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    renderer = index[index.index("function inline(text)"):index.index("function parseList")]
    sanitizer = index[index.index("const _ALLOWED_TAGS"):index.index("function appendMsg")]

    assert "<img" not in renderer.lower()
    assert "'IMG'" not in sanitizer
    assert "return '<a href=\"' + url" in renderer
    assert "&quot;([\\s\\S]*?)&quot;" in renderer
    assert "(?:[^()\\s]|\\([^()\\s]*\\))+" in renderer


def test_voice_api_keys_are_never_persisted_to_local_storage():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    voice = index[index.index("// ── Voice (Azure Speech"):index.index("// ── Actions ──")]

    assert "safeSet('az_speech_key'" not in voice
    assert "safeSet('el_api_key'" not in voice
    assert voice.count("safeRemove('az_speech_key')") >= 2
    assert voice.count("safeRemove('el_api_key')") >= 2


def test_encrypted_voice_config_can_be_unlocked_after_refresh_without_persisting_password():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    voice = index[index.index("async function loadStoredVoiceConfig"):index.index(
        "document.getElementById('az-speech-key').addEventListener")]

    assert "response.status === 403" in voice
    assert "Enter the voice.zip password" in voice
    assert "'X-Voice-Password': password" in voice
    assert "voiceZipPassword ? { 'X-Voice-Password': voiceZipPassword }" in voice
    assert "safeSet('voiceZipPassword'" not in voice
    assert "safeSet('az_speech_key'" not in voice
    assert "safeSet('el_api_key'" not in voice


def test_registry_fetch_is_user_initiated_and_dropped_code_requires_confirmation():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    startup = index[index.index("checkHealth();"):index.index("// ── Drag & Drop Agents")]
    drop = index[index.index("window.addEventListener('drop'"):index.index("// ── Theme Toggle")]
    registry = index[index.index("function toggleRegistryPanel"):index.index("let rarRegistry")]

    assert "loadFeatured" not in startup
    assert "loadRarRegistry()" in registry
    assert "This executes Python code on your machine" in drop
    assert drop.index("confirm(") < drop.index("fetch(`${API}/agents/import`")


def test_transcript_import_validates_before_mutating_live_chat():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    helper = index[index.index("function normalizeImportedChat"):index.index("function importChat")]
    importer = index[index.index("function importChat"):index.index("// ══")]

    assert "Array.isArray(data.turns)" in helper
    assert "Turn ${index + 1} must be an object" in helper
    assert "Turn ${index + 1} role is required" in helper
    assert "Turn ${index + 1} content is required" in helper
    assert "content must be a string" in helper
    assert "agent_logs must be a string" in helper
    assert importer.index("file.size > 16 * 1024 * 1024") < importer.index("reader.readAsText(file)")
    assert importer.index("normalizeImportedChat(") < importer.index("conversationEpoch += 1")
    assert importer.index("normalizeImportedChat(") < importer.index("cancelActiveRequests(true)")


def test_tour_registry_path_renders_featured_content_after_lazy_load():
    index = open(os.path.join(bs._BASE_DIR, "index.html"), encoding="utf-8").read()
    tour = index[index.index("const openPanel ="):index.index("async function agentFiles")]

    assert "const openRegistry" in tour
    assert "loadFeatured()" in tour


def test_launchers_probe_all_runtime_dependencies_and_use_python_m_pip():
    root = bs._BASE_DIR
    powershell = open(os.path.join(root, "start.ps1"), encoding="utf-8").read()
    shell = open(os.path.join(root, "start.sh"), encoding="utf-8").read()
    for launcher in (powershell, shell):
        assert "pyzipper" in launcher
        assert "-m pip" in launcher
        assert "sys.version_info >= (3, 11)" in launcher
    assert "$managedPython" in powershell
    assert "py -3 -c" in powershell
    assert '@($managedPython, $launcherPython, "python", "python3")' in powershell
    assert "@($env:Path, $machinePath, $userPath)" in powershell
    assert "python3.14" in shell
    assert "for candidate in" in shell
    assert 'python_supported "$candidate_path"' in shell
    assert "chmod 600 .env" in shell


def test_docs_describe_optional_voice_credentials_and_hot_agent_discovery():
    root = bs._BASE_DIR
    readme = open(os.path.join(root, "README.md"), encoding="utf-8").read()
    constitution = open(os.path.join(root, "CONSTITUTION.md"), encoding="utf-8").read()
    env_example = open(os.path.join(root, ".env.example"), encoding="utf-8").read()
    manifest = open(
        os.path.join(root, "tests", "soul_defaults.sha256"), encoding="utf-8"
    ).read()

    assert "optional Azure Speech and ElevenLabs" in readme
    assert "`VOICE_ZIP_PASSWORD`" in readme
    assert "Auto-discovered on every request" in constitution
    assert "Optional\nintegrations may use credentials" in constitution
    assert "Azure Speech or ElevenLabs config" in env_example
    assert "rapp_brainstem/tests/soul_hash.py" in manifest


# ── /chat input validation always returns JSON (never an HTML 400/500) ─────────

def test_chat_rejects_non_json_body_as_json():
    r = bs.app.test_client().post("/chat", data="{ not json",
                                  content_type="application/json")
    assert r.status_code == 400 and r.is_json and "error" in r.get_json()


def test_chat_rejects_non_string_user_input():
    r = bs.app.test_client().post("/chat", json={"user_input": 123})
    assert r.status_code == 400 and r.get_json()["error"]


def test_chat_requires_non_empty_user_input():
    r = bs.app.test_client().post("/chat", json={"user_input": "   "})
    assert r.status_code == 400


@pytest.mark.parametrize("history", [[None], ["bad"], [{"role": "user", "content": 7}]])
def test_chat_rejects_malformed_history_as_json(history):
    r = bs.app.test_client().post(
        "/chat", json={"user_input": "hi", "conversation_history": history})
    assert r.status_code == 400 and r.is_json and "conversation_history" in r.get_json()["error"]


def test_stream_rejects_malformed_history_as_json():
    r = bs.app.test_client().post(
        "/chat/stream", json={"user_input": "hi", "conversation_history": [None]})
    assert r.status_code == 400 and r.is_json


@pytest.mark.parametrize("arguments", ["{not json", "[]"])
def test_invalid_tool_arguments_do_not_invoke_agent(arguments):
    class CountingAgent:
        calls = 0

        def perform(self, **kwargs):
            self.calls += 1
            return "unexpected"

    agent = CountingAgent()
    results, logs = bs.run_tool_calls(
        [{"id": "call-1", "function": {"name": "Writer", "arguments": arguments}}],
        {"Writer": agent},
    )

    assert agent.calls == 0
    assert results == [{
        "tool_call_id": "call-1",
        "role": "tool",
        "name": "Writer",
        "content": "Error: Tool arguments must be a valid JSON object.",
    }]
    assert logs == ["[Writer] Error: Tool arguments must be a valid JSON object."]


def test_chat_finalizes_tool_calls_even_when_last_round_has_interim_text(monkeypatch):
    class LookupAgent:
        name = "Lookup"

        def to_tool(self):
            return {
                "type": "function",
                "function": {
                    "name": self.name,
                    "parameters": {"type": "object", "properties": {}},
                },
            }

        def system_context(self):
            return ""

        def perform(self, **kwargs):
            return "the final fact"

    calls = []

    def fake_copilot(messages, tools=None, model=None):
        calls.append(tools)
        if len(calls) <= 3:
            return ({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": "Let me check.",
                        "tool_calls": [{
                            "id": f"call-{len(calls)}",
                            "type": "function",
                            "function": {"name": "Lookup", "arguments": "{}"},
                        }],
                    },
                    "finish_reason": "tool_calls",
                }],
            }, "gpt-4o")
        return ({
            "choices": [{
                "message": {"role": "assistant", "content": "The answer uses the final fact."},
                "finish_reason": "stop",
            }],
        }, "gpt-4o")

    monkeypatch.setattr(bs, "load_soul", lambda: "SOUL")
    monkeypatch.setattr(bs, "load_agents", lambda: {"Lookup": LookupAgent()})
    monkeypatch.setattr(bs, "call_copilot", fake_copilot)

    response = bs.app.test_client().post("/chat", json={"user_input": "look it up"})

    assert response.status_code == 200
    assert response.get_json()["response"] == "The answer uses the final fact."
    assert len(calls) == 4
    assert all(tools for tools in calls[:3])
    assert calls[3] is None


def test_chat_does_not_return_interim_text_when_finalization_fails(monkeypatch):
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
            return "tool result"

    calls = 0

    def fake_copilot(messages, tools=None, model=None):
        nonlocal calls
        calls += 1
        if calls == 4:
            raise RuntimeError("finalization failed")
        return ({"choices": [{
            "message": {
                "role": "assistant",
                "content": "Let me check.",
                "tool_calls": [{
                    "id": f"call-{calls}",
                    "type": "function",
                    "function": {"name": "Lookup", "arguments": "{}"},
                }],
            },
            "finish_reason": "tool_calls",
        }]}, "gpt-4o")

    monkeypatch.setattr(bs, "load_soul", lambda: "SOUL")
    monkeypatch.setattr(bs, "load_agents", lambda: {"Lookup": LookupAgent()})
    monkeypatch.setattr(bs, "call_copilot", fake_copilot)

    response = bs.app.test_client().post("/chat", json={"user_input": "look it up"})

    assert response.status_code == 200
    assert response.get_json()["response"].startswith("I couldn't finish")
    assert response.get_json()["response"] != "Let me check."


# ── DELETE cannot remove the shared base class ─────────────────────────────────

def test_cannot_delete_basic_agent():
    r = bs.app.test_client().delete("/agents/basic_agent.py")
    assert r.status_code == 400
    base = os.path.join(bs._BASE_DIR, "agents", "basic_agent.py")
    assert os.path.exists(base), "basic_agent.py must remain"


def test_cannot_replace_basic_agent(tmp_path, monkeypatch):
    from io import BytesIO

    base = tmp_path / "basic_agent.py"
    base.write_text("sentinel", encoding="utf-8")
    monkeypatch.setattr(bs, "AGENTS_PATH", str(tmp_path))
    r = bs.app.test_client().post(
        "/agents/import",
        data={"file": (BytesIO(b"print('should not run')"), "basic_agent.py")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400
    assert base.read_text(encoding="utf-8") == "sentinel"


def test_loader_ignores_imported_class_alias(tmp_path):
    source = tmp_path / "alias_agent.py"
    source.write_text(
        "from agents.basic_agent import BasicAgent as Parent\n"
        "class LocalAgent(Parent):\n"
        "    def __init__(self):\n"
        "        self.name = 'Local'\n"
        "        self.metadata = {'name': 'Local', 'description': 'local', "
        "'parameters': {'type': 'object', 'properties': {}}}\n"
        "        super().__init__(self.name, self.metadata)\n"
        "    def perform(self, **kwargs):\n"
        "        return 'ok'\n",
        encoding="utf-8",
    )
    assert list(bs._load_agent_from_file(str(source))) == ["Local"]


# ── call_copilot: an empty "choices" array is a clean error, not an IndexError ──

def test_call_copilot_empty_choices_raises_runtimeerror(monkeypatch):
    monkeypatch.setattr(bs, "get_copilot_token", lambda: ("tok", "https://ep"))

    class FakeResp:
        status_code = 200
        text = "{}"
        encoding = "utf-8"
        def raise_for_status(self):
            pass
        def json(self):
            return {"choices": []}

    monkeypatch.setattr(bs.requests, "post", lambda *a, **k: FakeResp())
    with pytest.raises(RuntimeError):
        bs.call_copilot([{"role": "user", "content": "hi"}])


# ── Atomic JSON write helper leaves no temp files and round-trips ──────────────

def test_atomic_write_json_roundtrip(tmp_path):
    p = str(tmp_path / "state.json")
    bs._atomic_write_json(p, {"a": 1, "b": [2, 3]})
    assert json.load(open(p, encoding="utf-8")) == {"a": 1, "b": [2, 3]}
    assert os.listdir(tmp_path) == ["state.json"]  # no leftover .tmp


def test_atomic_binary_failure_preserves_previous_file(tmp_path, monkeypatch):
    path = tmp_path / "agent.py"
    path.write_bytes(b"previous complete file")

    def fail_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(bs.os, "replace", fail_replace)
    with pytest.raises(OSError):
        bs._atomic_write_bytes(str(path), b"partial replacement")

    assert path.read_bytes() == b"previous complete file"
    assert os.listdir(tmp_path) == ["agent.py"]


# ── Relative SOUL/AGENTS paths resolve against the brainstem dir, not the CWD ──

def test_relative_paths_resolve_under_base():
    assert bs._resolve_under_base("./soul.md", "soul.md") == os.path.join(bs._BASE_DIR, "./soul.md")
    assert bs._resolve_under_base(None, "agents") == os.path.join(bs._BASE_DIR, "agents")
    absolute_path = os.path.abspath(os.path.join(os.sep, "abs", "s.md"))
    assert bs._resolve_under_base(absolute_path, "soul.md") == absolute_path


# ── local_storage: traversal containment + bare-filename safety ────────────────

def test_storage_blocks_traversal(tmp_path, monkeypatch):
    monkeypatch.setattr(local_storage, "_DATA_DIR", str(tmp_path))
    with pytest.raises(ValueError):
        local_storage._safe_join("../../etc/passwd")
    m = local_storage.AzureFileStorageManager()
    with pytest.raises(ValueError):
        m.set_memory_context("../../escape")


def test_storage_blocks_symlink_escape(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    outside = tmp_path / "outside"
    data_dir.mkdir()
    outside.mkdir()
    link = data_dir / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("directory symlinks are unavailable on this host")

    monkeypatch.setattr(local_storage, "_DATA_DIR", str(data_dir))
    with pytest.raises(ValueError):
        local_storage._safe_join("linked", "escaped.json")


@pytest.mark.skipif(os.name != "posix", reason="POSIX file modes only")
def test_storage_files_are_private_on_posix(tmp_path, monkeypatch):
    import stat

    monkeypatch.setattr(local_storage, "_DATA_DIR", str(tmp_path))
    manager = local_storage.AzureFileStorageManager()
    manager.write_json({"secret": True})
    assert stat.S_IMODE(os.stat(tmp_path).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(manager._file_path()).st_mode) == 0o600


def test_storage_bare_filename_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(local_storage, "_DATA_DIR", str(tmp_path))
    m = local_storage.AzureFileStorageManager()
    m.write_json({"k": 1}, file_path="bare.json")   # dirname("") no longer crashes
    assert m.read_json(file_path="bare.json") == {"k": 1}


# ── Memory recall tolerates a corrupted (non-dict) store instead of crashing ───

def test_context_memory_tolerates_corrupt_store(tmp_path, monkeypatch):
    monkeypatch.setattr(local_storage, "_DATA_DIR", str(tmp_path))
    agents_dir = os.path.join(bs._BASE_DIR, "agents")
    ctx = bs._load_agent_from_file(os.path.join(agents_dir, "context_memory_agent.py"))["ContextMemory"]
    with open(ctx.storage_manager._file_path(), "w", encoding="utf-8") as f:
        f.write("[1, 2, 3]")     # a JSON array, not the expected object
    out = ctx.perform(full_recall=True)   # must not raise
    assert isinstance(out, str)


def test_context_memory_system_prompt_is_bounded_and_marks_data_untrusted(tmp_path, monkeypatch):
    monkeypatch.setattr(local_storage, "_DATA_DIR", str(tmp_path))
    agents_dir = os.path.join(bs._BASE_DIR, "agents")
    ctx = bs._load_agent_from_file(os.path.join(agents_dir, "context_memory_agent.py"))["ContextMemory"]
    ctx.storage_manager.write_json({
        str(index): {
            "message": "x" * 2000,
            "theme": "fact",
            "date": "2026-07-09",
            "time": f"00:00:{index:02d}",
        }
        for index in range(60)
    })
    prompt = ctx.system_context()
    assert len(prompt) < 13000
    assert "untrusted user data" in prompt


def test_soul_reloads_when_file_changes(tmp_path, monkeypatch):
    soul = tmp_path / "soul.md"
    soul.write_text("first soul", encoding="utf-8")
    monkeypatch.setattr(bs, "SOUL_PATH", str(soul))
    monkeypatch.setattr(bs, "_soul_cache", None)
    assert bs.load_soul() == "first soul"

    soul.write_text("second soul with a different size", encoding="utf-8")
    assert bs.load_soul() == "second soul with a different size"
