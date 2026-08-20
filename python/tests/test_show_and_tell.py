import hashlib
import json
import secrets
import sys
import threading
import time
from pathlib import Path

from openrappter.agents.show_and_tell_agent import ShowAndTellAgent
from openrappter.show_and_tell import (
    SHOW_AND_TELL_ANALYSIS_SCHEMA,
    SHOW_AND_TELL_SCHEMA,
    ShowAndTellStore,
    artifact_contains_sensitive_text,
    build_deterministic_analysis,
    is_private_context,
    safe_computer_action_data,
    privacy_reduced_path,
    privacy_reduced_url,
    revise_analysis,
    run_collector,
)
import pytest


def seed_consent(store, purpose):
    store.initialize()
    token = secrets.token_hex(32)
    now = int(time.time() * 1000)
    store.connection.execute(
        "INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (hashlib.sha256(token.encode()).hexdigest(), purpose, now, now + 60_000),
    )
    return token


def test_contract_and_session_schema_match(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session(intent_hint="Submit an expense report")
    assert session["schema"] == SHOW_AND_TELL_SCHEMA
    assert session["captureMode"] == "context"

    contract = json.loads(
        (Path(__file__).parents[2] / "contracts" / "show-and-tell-v1.json").read_text()
    )
    assert contract["session"]["schema"] == SHOW_AND_TELL_SCHEMA
    store.close()


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation needs privileges")
def test_symlinked_database_is_rejected_before_sqlite_follows_it(tmp_path):
    root = tmp_path / "show"
    root.mkdir()
    target = root / "outside.db"
    target.write_text("do not overwrite")
    (root / "show-and-tell.db").symlink_to(target)
    store = ShowAndTellStore(root)
    with pytest.raises(RuntimeError, match="regular file"):
        store.initialize()
    assert target.read_text() == "do not overwrite"


def test_consent_is_single_use(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    token = seed_consent(store, "start")
    assert store.consume_consent(token, "start") is True
    assert store.consume_consent(token, "start") is False
    store.close()


def test_event_sequence_is_shared_across_store_instances(tmp_path):
    root = tmp_path / "show"
    first = ShowAndTellStore(root)
    second = ShowAndTellStore(root)
    session = first.create_session()
    first.append_event(session["id"], "session.note", "test", {"note": "one"})
    second.append_event(session["id"], "session.note", "test", {"note": "two"})
    assert [event["sequence"] for event in first.events(session["id"])] == [0, 1]
    first.close()
    second.close()


def test_second_collector_cannot_replace_attached_owner(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session()
    assert store.attach_collector(session["id"], "python", 101, "first")
    assert not store.attach_collector(
        session["id"], "typescript", 202, "second"
    )
    attached = store.get_session(session["id"])
    assert attached["collectorRuntime"] == "python"
    assert attached["collectorPid"] == 101
    assert attached["collectorNonce"] == "first"
    store.close()


def test_stale_session_is_failed_before_replacement(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session()
    store.connection.execute(
        "UPDATE show_sessions SET started_at = 0 WHERE id = ?", (session["id"],)
    )
    assert store.recover_stale_sessions(1) == 1
    assert store.get_session(session["id"])["state"] == "failed"
    replacement = store.create_session()
    assert replacement["id"] != session["id"]
    store.close()


def test_collector_finalizes_when_terminal_event_write_fails(tmp_path, monkeypatch):
    root = tmp_path / "show"
    store = ShowAndTellStore(root)
    session = store.create_session()
    store.connection.execute(
        "UPDATE show_sessions SET started_at = 0 WHERE id = ?", (session["id"],)
    )
    original = ShowAndTellStore.append_event

    def flaky_append(self, session_id, event_type, source, data=None):
        if event_type == "collector.stopped":
            raise RuntimeError("simulated terminal event contention")
        return original(self, session_id, event_type, source, data)

    monkeypatch.setattr(ShowAndTellStore, "append_event", flaky_append)
    run_collector(root, session["id"], "finalization-test")
    assert store.get_session(session["id"])["state"] == "stopped"
    store.close()


def test_status_recovers_a_dead_collector_process(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session()
    store.attach_collector(
        session["id"],
        "python",
        2_147_483_647,
        "dead-collector",
    )
    agent = ShowAndTellAgent(root=tmp_path / "show")
    status = json.loads(agent.perform(action="status", session_id=session["id"]))
    assert status["session"]["state"] == "failed"
    assert status["collector_healthy"] is True
    assert "process exited" in status["session"]["lastError"]
    store.close()


def test_agent_uses_thread_local_store_connections(tmp_path):
    agent = ShowAndTellAgent(root=tmp_path / "show", local_surface=True)
    stores = []
    results = []
    barrier = threading.Barrier(2)

    def collect():
        barrier.wait()
        result = json.loads(agent.perform(action="list"))
        results.append(result)
        if result.get("status") == "success":
            store = agent.store
            stores.append((store, store.connection))
            store.close()

    first = threading.Thread(target=collect)
    second = threading.Thread(target=collect)
    first.start()
    second.start()
    first.join()
    second.join()
    assert [result["status"] for result in results] == ["success", "success"]
    assert len(stores) == 2
    assert stores[0][0] is not stores[1][0]
    assert stores[0][1] is not stores[1][1]


def test_healthy_sixty_second_poll_is_not_recovered_as_stale(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session(poll_interval_ms=60_000)
    store.attach_collector(session["id"], "python", 42, "nonce")
    assert store.recover_stale_sessions() == 0
    assert store.get_session(session["id"])["state"] == "recording"
    store.close()


def test_only_one_active_session_can_exist_across_store_instances(tmp_path):
    root = tmp_path / "show"
    first = ShowAndTellStore(root)
    second = ShowAndTellStore(root)
    first.create_session(intent_hint="first")
    try:
        second.create_session(intent_hint="second")
    except RuntimeError:
        pass
    else:
        raise AssertionError("a second active session was created")
    active = [
        session
        for session in first.list_sessions()
        if session["state"] in {"recording", "stopping"}
    ]
    assert len(active) == 1
    first.close()
    second.close()


def test_start_requires_local_consent(tmp_path):
    agent = ShowAndTellAgent(
        root=tmp_path / "show",
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
    )
    result = json.loads(agent.perform(action="start"))
    assert result["status"] == "error"
    assert result["code"] == "local_consent_required"


def test_model_surface_does_not_return_private_recording_details(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session(
        title="Confidential launch",
        intent_hint="Do not send this private workflow to a model",
    )
    store.finish_session(session["id"], "stopped")
    agent = ShowAndTellAgent(
        root=tmp_path / "show",
        local_surface=False,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
    )
    status = json.loads(agent.perform(action="status", session_id=session["id"]))
    assert "Confidential launch" not in json.dumps(status)
    assert "private workflow" not in json.dumps(status)
    denied = json.loads(
        agent.perform(action="analyze", session_id=session["id"])
    )
    assert denied["code"] == "local_surface_required"
    store.close()


def test_full_flow_builds_portable_skill_and_disabled_automation(tmp_path, monkeypatch):
    root = tmp_path / "show"
    monkeypatch.setenv("OPENRAPPTER_SKILLS_DIR", str(tmp_path / "skills"))
    monkeypatch.setenv("OPENRAPPTER_AUTOMATIONS_DIR", str(tmp_path / "automations"))
    store = ShowAndTellStore(root)
    token = seed_consent(store, "start")
    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "collector-nonce",
            "verify": False,
        },
    )
    started = json.loads(
        agent.perform(
            action="start",
            intent="Create a weekly project status report",
            consent_token=token,
        )
    )
    session_id = started["session"]["id"]
    agent.perform(
        action="observe",
        session_id=session_id,
        title="Collect project updates",
        detail="Gathered the completed work, blockers, and next steps.",
        app="Terminal",
    )
    agent.perform(
        action="note",
        session_id=session_id,
        note="The report should be concise and ready to send to the team.",
    )
    store.finish_session(session_id, "stopped")

    analyzed = json.loads(agent.perform(action="analyze", session_id=session_id))
    assert analyzed["analysis"]["schema"] == SHOW_AND_TELL_ANALYSIS_SCHEMA
    assert analyzed["analysis"]["approved"] is False

    denied = json.loads(
        agent.perform(action="review", session_id=session_id, approve=True)
    )
    assert denied["code"] == "local_approval_required"

    approval = seed_consent(store, "approve")
    approved = json.loads(
        agent.perform(
            action="review",
            session_id=session_id,
            approve=True,
            consent_token=approval,
        )
    )
    assert approved["analysis"]["approved"] is True

    built = json.loads(
        agent.perform(action="build", session_id=session_id, target="all")
    )
    assert [artifact["kind"] for artifact in built["artifacts"]] == [
        "skill",
        "automation",
    ]
    skill = Path(built["artifacts"][0]["path"]).read_text()
    assert "Prefer a native API, CLI, filesystem, or browser tool" in skill
    automation = json.loads(Path(built["artifacts"][1]["path"]).read_text())
    assert automation["enabled"] is False

    tested = json.loads(agent.perform(action="test", session_id=session_id))
    assert tested["status"] == "success"
    assert tested["ok"] is True
    second_approval = seed_consent(store, "approve")
    revised = json.loads(
        agent.perform(
            action="review",
            session_id=session_id,
            intent="Create a revised weekly project status report",
            approve=True,
            consent_token=second_approval,
        )
    )
    assert revised["analysis"]["revision"] > analyzed["analysis"]["revision"]
    stale = json.loads(agent.perform(action="test", session_id=session_id))
    assert stale["status"] == "error"
    assert any(
        check["name"].endswith("-analysis-revision") and not check["ok"]
        for check in stale["checks"]
    )
    rebuilt = json.loads(
        agent.perform(action="build", session_id=session_id, target="all")
    )
    assert rebuilt["status"] == "success"
    assert len([
        artifact
        for artifact in store.artifacts(session_id)
        if artifact["kind"] == "skill"
    ]) == 1

    manifest = Path(built["artifacts"][0]["path"]).parent / "manifest.json"
    manifest.write_text(
        json.dumps({"sourceSessionId": "other-session", "name": "tampered"})
    )
    tampered = json.loads(agent.perform(action="test", session_id=session_id))
    assert tampered["status"] == "error"
    assert next(
        check for check in tampered["checks"] if check["name"] == "skill-manifest"
    )["ok"] is False
    store.close()


def test_private_context_refuses_explicit_frame(tmp_path):
    store = ShowAndTellStore(tmp_path / "show")
    session = store.create_session()
    captured = []
    agent = ShowAndTellAgent(
        root=tmp_path / "show",
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
        read_context=lambda: {
            "app": "1Password",
            "window": "Sign in",
            "privateContext": True,
        },
        capture=lambda path, _context: captured.append(path),
    )
    capture_token = seed_consent(store, "capture")
    result = json.loads(
        agent.perform(
            action="capture",
            session_id=session["id"],
            consent_token=capture_token,
        )
    )
    assert result["status"] == "error"
    assert result["code"] == "private_context"
    assert captured == []
    store.close()


def test_frame_is_deleted_if_active_window_changes_during_capture(tmp_path):
    root = tmp_path / "show"
    store = ShowAndTellStore(root)
    session = store.create_session()
    contexts = iter(
        [
            {
                "app": "Browser",
                "window": "Expected window",
                "windowId": "one",
                "x": 0,
                "y": 0,
                "width": 800,
                "height": 600,
            },
            {
                "app": "Browser",
                "window": "Different window",
                "windowId": "two",
                "x": 0,
                "y": 0,
                "width": 800,
                "height": 600,
            },
        ]
    )
    captured = []

    def capture(path, _context):
        captured.append(path)
        path.write_text("frame")

    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
        read_context=lambda: next(contexts),
        capture=capture,
    )
    token = seed_consent(store, "capture")
    result = json.loads(
        agent.perform(
            action="capture",
            session_id=session["id"],
            consent_token=token,
        )
    )
    assert result["code"] == "window_changed"
    assert captured and not captured[0].exists()
    store.close()


def test_frame_is_deleted_if_page_becomes_private_during_capture(tmp_path):
    root = tmp_path / "show"
    store = ShowAndTellStore(root)
    session = store.create_session()
    contexts = iter(
        [
            {
                "app": "Safari",
                "window": "Google Accounts",
                "windowId": "one",
                "url": "https://accounts.example.com/home",
            },
            {
                "app": "Safari",
                "window": "Google Accounts",
                "windowId": "one",
                "url": "https://accounts.example.com/signin/oauth",
            },
        ]
    )
    captured = []

    def capture(path, _context):
        captured.append(path)
        path.write_text("frame")

    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
        read_context=lambda: next(contexts),
        capture=capture,
    )
    token = seed_consent(store, "capture")
    result = json.loads(
        agent.perform(
            action="capture",
            session_id=session["id"],
            consent_token=token,
        )
    )
    assert result["code"] == "private_context"
    assert captured and not captured[0].exists()
    store.close()


def test_successful_capture_result_does_not_expose_frame_paths(tmp_path):
    root = tmp_path / "show"
    store = ShowAndTellStore(root)
    session = store.create_session()
    context = {
        "app": "Browser",
        "window": "Public documentation",
        "windowId": "one",
        "x": 0,
        "y": 0,
        "width": 800,
        "height": 600,
    }

    def capture(path, _context):
        path.write_text("frame")

    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
        read_context=lambda: context,
        capture=capture,
    )
    token = seed_consent(store, "capture")
    result = json.loads(
        agent.perform(
            action="capture",
            session_id=session["id"],
            title="Public docs",
            consent_token=token,
        )
    )
    assert result == {
        "status": "success",
        "action": "capture",
        "session_id": session["id"],
        "captured": True,
        "label": "Public docs",
    }
    assert "frames/" not in json.dumps(result)
    store.close()


def test_python_model_enhancement_is_consent_gated_and_explicitly_unavailable(tmp_path):
    root = tmp_path / "show"
    store = ShowAndTellStore(root)
    session = store.create_session(intent_hint="Document a release workflow")
    store.finish_session(session["id"], "stopped")
    agent = ShowAndTellAgent(
        root=root,
        spawn=lambda _root, _session: {
            "pid": 42,
            "nonce": "nonce",
            "verify": False,
        },
    )
    denied = json.loads(
        agent.perform(action="analyze", session_id=session["id"], enhance=True)
    )
    assert denied["code"] == "local_analysis_consent_required"
    token = seed_consent(store, "analyze")
    unavailable = json.loads(
        agent.perform(
            action="analyze",
            session_id=session["id"],
            enhance=True,
            consent_token=token,
        )
    )
    assert unavailable["code"] == "model_unavailable"
    store.close()


def test_computer_action_never_persists_typed_text():
    data = safe_computer_action_data(
        "type", {"text": "ghp_this_would_be_a_secret_token"}
    )
    assert data == {"action": "type", "textLength": 32, "textStored": False}
    assert "ghp_" not in json.dumps(data)
    assert safe_computer_action_data(
        "key", {"text": "private recovery phrase"}
    ) == {"action": "key", "keyLength": 23, "keyStored": False}
    assert safe_computer_action_data("key", {"text": "cmd+c"}) == {
        "action": "key",
        "key": "cmd+c",
    }


def test_privacy_reduced_url_rejects_local_schemes_and_opaque_tokens():
    assert privacy_reduced_url("file:///Users/alice/SecretPlans.docx") == ""
    assert privacy_reduced_url("javascript:alert(1)") == ""
    assert privacy_reduced_url(
        "https://example.com/reset/dGVzdC11c2VyLWludml0ZS10b2tlbg?token=secret"
    ) == "https://example.com/reset/:id"
    jwt = ".".join(
        [
            "eyJhbGciOiJIUzI1NiJ9",
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        ]
    )
    assert privacy_reduced_url(
        f"https://example.com/callback/{jwt}"
    ) == "https://example.com/callback/:id"
    assert privacy_reduced_url(
        f"https://example.com/callback/{jwt.replace('.', '%2E')}"
    ) == "https://example.com/callback/:id"
    assert artifact_contains_sensitive_text(json.dumps({"url": jwt}))
    assert is_private_context("Safari", "Google Accounts", "/signin/oauth")
    assert is_private_context("Google Chrome", "New Incognito Tab")
    assert is_private_context("Microsoft Edge", "InPrivate browsing")
    assert is_private_context("Safari", "Private Browsing")


def test_privacy_reduced_path_publishes_the_choice_and_not_the_machine():
    home = str(Path.home())

    # Home is the same instruction on every machine, so it survives as `~`.
    assert privacy_reduced_path(home) == "~"
    assert privacy_reduced_path(f"{home}/Documents/receipts") == "~/Documents/receipts"
    assert privacy_reduced_path("~/Documents/receipts") == "~/Documents/receipts"

    # Anywhere else, only the last segment is kept: a reader needs to know it
    # was "receipts", never whose account or which directory tree held it.
    assert privacy_reduced_path("/Users/demo/Documents/receipts") == "<absolute>/receipts"
    assert privacy_reduced_path("/Users/demo/Documents/receipts/") == "<absolute>/receipts"
    assert privacy_reduced_path("C:\\Users\\demo\\Documents") == "<absolute>/Documents"
    assert privacy_reduced_path("/") == "<absolute>/path"

    # A relative path is dropped rather than guessed at: nothing here knows
    # what it was relative to.
    assert privacy_reduced_path("relative/path") == ""
    assert privacy_reduced_path("") == ""
    assert privacy_reduced_path("   ") == ""
    assert privacy_reduced_path(None) == ""


def test_privacy_reduced_path_never_leaks_the_account_name_it_was_given():
    home = str(Path.home())
    account = Path(home).name

    for raw in (home, f"{home}/Documents/receipts", f"/Users/{account}/elsewhere"):
        reduced = privacy_reduced_path(raw)
        assert reduced, "a real absolute path must still produce an example"
        assert account not in reduced


def test_privacy_reduced_path_drops_a_path_it_cannot_publish_safely():
    # Assembled at runtime on purpose: a token written out in full is still
    # a token in the repository, whatever the file around it is for.
    header = "eyJ" + "hbGciOiJIUzI1NiJ9"
    token = ".".join(
        [header, "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"]
    )

    # The sanitizer runs first. When it redacts the whole path there is no
    # example left to publish, and an empty string is the honest answer.
    assert privacy_reduced_path(f"/var/folders/session/{token}") == ""


def test_privacy_reduced_path_keeps_only_the_basename_of_an_absolute_path():
    reduced = privacy_reduced_path("/private/var/folders/T/session-4821/receipts")

    # Whatever the tree above it was, none of it is published: the basename
    # is the only part that tells a reader what was chosen.
    assert reduced == "<absolute>/receipts"
    for segment in ("private", "var", "folders", "session-4821"):
        assert segment not in reduced


def test_deterministic_analysis_uses_semantic_events_not_frame_pixels():
    now = 1
    analysis = build_deterministic_analysis(
        {
            "schema": SHOW_AND_TELL_SCHEMA,
            "id": "session-1",
            "state": "stopped",
            "title": "",
            "intentHint": "Research an article and save the useful link",
            "captureMode": "context",
            "createdAt": now,
            "startedAt": now,
            "stoppedAt": now,
            "updatedAt": now,
            "collectorRuntime": None,
            "collectorPid": None,
            "collectorNonce": None,
            "collectorStartedAt": None,
            "collectorHeartbeatAt": None,
            "stopRequestedAt": now,
            "maxDurationMs": 60_000,
            "pollIntervalMs": 2_000,
            "lastError": None,
        },
        [
            {
                "id": "e1",
                "sessionId": "session-1",
                "sequence": 0,
                "timestamp": now,
                "type": "browser.url",
                "source": "test",
                "data": {
                    "app": "Safari",
                    "url": "https://example.com/articles/:id",
                },
            },
            {
                "id": "e2",
                "sessionId": "session-1",
                "sequence": 1,
                "timestamp": now,
                "type": "frame.captured",
                "source": "test",
                "data": {"file": "frames/frame.png"},
            },
            {
                "id": "e3",
                "sessionId": "session-1",
                "sequence": 2,
                "timestamp": now,
                "type": "computer.action",
                "source": "test",
                "data": {"action": "click", "status": "error"},
            },
        ],
    )
    assert analysis["intent"].startswith("Research an article")
    assert len(analysis["steps"]) == 1
    assert analysis["steps"][0]["tool"] == "Browser or Web"


def test_deterministic_analysis_keeps_narration_as_a_step():
    now = int(time.time() * 1000)
    analysis = build_deterministic_analysis(
        {
            "schema": SHOW_AND_TELL_SCHEMA,
            "id": "narrated-session",
            "state": "stopped",
            "title": "",
            "intentHint": "Prepare the weekly update",
            "captureMode": "context",
            "createdAt": now,
            "startedAt": now,
            "stoppedAt": now,
            "updatedAt": now,
            "collectorRuntime": None,
            "collectorPid": None,
            "collectorNonce": None,
            "collectorStartedAt": None,
            "collectorHeartbeatAt": None,
            "stopRequestedAt": now,
            "maxDurationMs": 60_000,
            "pollIntervalMs": 2_000,
            "lastError": None,
        },
        [
            {
                "id": "note-1",
                "sessionId": "narrated-session",
                "sequence": 0,
                "timestamp": now,
                "type": "narration.transcribed",
                "source": "local-whisper",
                "data": {"text": "Summarize blockers before listing next steps."},
            }
        ],
    )
    assert analysis["steps"][0]["title"] == "Follow the narrated instruction"
    assert "Summarize blockers" in analysis["steps"][0]["detail"]
    assert "event:0:narration.transcribed" in analysis["steps"][0]["evidence"]


def test_revise_analysis_privacy_reduces_step_urls():
    now = int(time.time() * 1000)
    revised = revise_analysis(
        {
            "schema": SHOW_AND_TELL_ANALYSIS_SCHEMA,
            "sessionId": "session-1",
            "revision": 1,
            "title": "Research",
            "intent": "Research safely",
            "intentRationale": "Test",
            "intentConfidence": "high",
            "steps": [
                {
                    "id": "s1",
                    "title": "Search",
                    "detail": "Search for the report.",
                    "kind": "action",
                    "tool": "Browser or Web",
                    "app": "Safari",
                    "url": "https://example.com/start",
                    "evidence": [],
                    "confidence": "high",
                }
            ],
            "feedbackLog": [],
            "approved": False,
            "approvedAt": None,
            "createdAt": now,
            "updatedAt": now,
        },
        steps_json=json.dumps(
            [
                {
                    "id": "s1",
                    "title": "Search",
                    "detail": "Search for the report.",
                    "kind": "action",
                    "tool": "Browser or Web",
                    "app": "Safari",
                    "url": "https://example.com/search?q=confidential#private",
                    "evidence": [],
                    "confidence": "high",
                }
            ]
        ),
    )
    assert revised["steps"][0]["url"] == "https://example.com/search"
