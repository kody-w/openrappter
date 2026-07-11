import json
import multiprocessing
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from openrappter.agents.context_memory_agent import ContextMemoryAgent
from openrappter.agents.manage_memory_agent import ManageMemoryAgent
from openrappter.imessage.config import ConfigError, IMessageConfig
from openrappter.imessage.service import IMessageService
from openrappter.imessage.state import IMessageState
from openrappter.imessage.rpc import ImsgRpcError


OWNER = "+15550000001"
FRIEND = "+15550000002"


def _memory_process_write(path, index):
    agent = ManageMemoryAgent()
    agent.memory_file = Path(path)
    agent.perform(content=f"process fact {index}")


class FakeSupervisor:
    def __init__(self):
        self.requests = []
        self.is_ready = True
        self.restart_count = 0
        self.last_error = None
        self.send_guid = "BOT-GUID"
        self.restart_calls = 0
        self.chats = []

    def start(self):
        return None

    def stop(self):
        return None

    def request(self, method, params=None, timeout=None):
        self.requests.append((method, dict(params or {}), timeout))
        if method == "send":
            return {"ok": True, "guid": self.send_guid}
        if method == "watch.subscribe":
            return {"subscription": 1}
        if method == "chats.list":
            return {"chats": list(self.chats)}
        return {}

    def restart(self):
        self.restart_calls += 1


def config(tmp_path, **overrides):
    values = {
        "rappter_instance_id": "rappter-test",
        "account_id": "account-test",
        "owner_handles": [OWNER],
        "owner_chat_ids": ["1", "iMessage;-;self"],
        "allowed_dm_handles": [FRIEND],
        "allowed_group_chat_ids": ["42", "iMessage;+;group"],
        "group_aliases": {"friends": "42"},
        "mention_required": True,
        "mention_tokens": ["@rappter"],
        "state_dir": str(tmp_path / "state"),
        "imsg_path": "/synthetic/imsg",
        "imsg_version": "0.12.3",
    }
    values.update(overrides)
    return IMessageConfig.from_dict(values)


def owner_message(guid="USER-1", rowid=1, text="hello"):
    return {
        "id": rowid,
        "guid": guid,
        "text": text,
        "sender": OWNER,
        "is_from_me": True,
        "is_group": False,
        "service": "iMessage",
        "chat_id": 1,
        "chat_guid": "iMessage;-;self",
        "participants": [OWNER],
    }


def group_message(guid="GROUP-1", rowid=2, text="@rappter hello", chat_id=42):
    return {
        "id": rowid,
        "guid": guid,
        "text": text,
        "sender": FRIEND,
        "is_from_me": False,
        "is_group": True,
        "service": "iMessage",
        "chat_id": chat_id,
        "chat_guid": f"iMessage;+;group-{chat_id}",
        "participants": [OWNER, FRIEND],
    }


def test_config_rejects_cross_principal_handle_links(tmp_path):
    with pytest.raises(ConfigError):
        config(
            tmp_path,
            identity_links={"one": [FRIEND], "two": [FRIEND]},
        )


def test_config_requires_single_fifo_worker(tmp_path):
    with pytest.raises(ConfigError):
        config(tmp_path, worker_count=2)


def test_config_rejects_owner_group_overlap(tmp_path):
    with pytest.raises(ConfigError):
        config(
            tmp_path,
            owner_chat_ids=["42"],
            allowed_group_chat_ids=["42"],
        )


def test_session_keys_are_stable_and_hide_transport_ids(tmp_path):
    state = IMessageState(config(tmp_path))
    keys = [
        state.owner_session_key(),
        state.dm_session_key(FRIEND),
        state.group_session_key("iMessage;+;group"),
    ]
    assert keys == [
        state.owner_session_key(),
        state.dm_session_key(FRIEND),
        state.group_session_key("iMessage;+;group"),
    ]
    assert all(OWNER not in key and FRIEND not in key and "group" not in key[16:] for key in keys)


def test_owner_round_trip_and_durable_echo_suppression(tmp_path):
    supervisor = FakeSupervisor()
    service = IMessageService(
        config(tmp_path),
        supervisor=supervisor,
        chat_runner=lambda prompt, history, session, trust: {"response": f"reply:{prompt}"},
    )
    assert service.process_message(owner_message()) == "replied"
    send = next(item for item in supervisor.requests if item[0] == "send")
    assert send[1]["chat_id"] == 1
    assert send[1]["service"] == "imessage"

    echo = owner_message(guid="BOT-GUID", rowid=2, text="🦖 reply:hello")
    assert service.process_message(echo) == "outbound_echo"
    # Text fallback records are one-shot: a later user message with the same
    # text must not be suppressed forever.
    assert service.process_message(
        owner_message(guid="USER-2", rowid=3, text="🦖 reply:hello")
    ) == "replied"

    restarted = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "must not run"},
    )
    assert restarted.process_message(echo) == "duplicate"


def test_group_requires_allowlist_and_mention_and_replies_to_origin(tmp_path):
    supervisor = FakeSupervisor()
    service = IMessageService(
        config(tmp_path),
        supervisor=supervisor,
        chat_runner=lambda prompt, history, session, trust: {"response": prompt},
    )
    assert service.process_message(group_message(text="not addressed")) == "mention_required"
    assert service.process_message(group_message(guid="G2", rowid=3)) == "replied"
    send = next(item for item in supervisor.requests if item[0] == "send")
    assert send[1]["chat_id"] == 42

    denied = IMessageService(
        config(tmp_path / "denied", allowed_group_chat_ids=[], group_aliases={}),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "no"},
    )
    assert denied.process_message(group_message(guid="G3", rowid=4)) == "group_not_allowed"


def test_failed_brainstem_turn_remains_retryable(tmp_path):
    attempts = {"count": 0}

    def runner(*_):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("synthetic")
        return {"response": "recovered"}

    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=runner,
    )
    message = owner_message(guid="RETRY", rowid=10)
    assert service.process_message(message) == "brainstem_failed"
    assert service.state.cursor_rowid is None
    assert service.process_message(message) == "replied"
    assert service.state.cursor_rowid == 10


def test_never_seen_stale_backlog_is_dropped_without_model_call(tmp_path):
    calls = {"count": 0}

    def runner(*_):
        calls["count"] += 1
        return {"response": "must not run"}

    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=runner,
    )
    message = owner_message(guid="STALE", rowid=11)
    message["created_at"] = (
        datetime.now(timezone.utc) - timedelta(hours=2)
    ).isoformat()
    assert service.process_message(message) == "stale_backlog"
    assert calls["count"] == 0


def test_previously_failed_message_retries_even_after_live_fence(tmp_path):
    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "recovered"},
    )
    message = owner_message(guid="OLD-RETRY", rowid=12)
    message["created_at"] = (
        datetime.now(timezone.utc) - timedelta(hours=2)
    ).isoformat()
    service.state.observe(12, "OLD-RETRY", message)
    service.state.mark_retryable(12, "OLD-RETRY")
    assert service.process_message(message) == "replied"


def test_first_pending_message_resumes_before_tail_after_restart(tmp_path):
    cfg = config(tmp_path)
    state = IMessageState(cfg)
    message = owner_message(guid="PENDING", rowid=42)
    state.observe(42, "PENDING", message)
    state.mark_retryable(42, "PENDING")
    state.close()

    restarted = IMessageState(cfg)
    assert restarted.watch_resume_rowid == 41
    assert restarted.retryable_messages(now=time.time() + 120)[0]["guid"] == "PENDING"


def test_second_service_cannot_acquire_live_transport_lease(tmp_path):
    first = IMessageState(config(tmp_path))
    second = IMessageState(config(tmp_path))
    assert first.acquire_lease("first", ttl_seconds=30)
    assert not second.acquire_lease("second", ttl_seconds=30)
    first.release_lease("first")
    assert second.acquire_lease("second", ttl_seconds=30)


def test_sms_fails_closed_when_chat_catalog_is_not_imessage(tmp_path):
    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "must not run"},
    )
    message = owner_message(guid="SMS", rowid=20)
    message["service"] = "SMS"
    assert service.process_message(message) == "non_imessage"


def test_missing_message_service_is_verified_from_chat_catalog(tmp_path):
    supervisor = FakeSupervisor()
    supervisor.chats = [{"id": 1, "guid": "iMessage;-;self", "service": "iMessage"}]
    service = IMessageService(
        config(tmp_path),
        supervisor=supervisor,
        chat_runner=lambda *_: {"response": "verified"},
    )
    message = owner_message(guid="CATALOG", rowid=21)
    message.pop("service")
    assert service.process_message(message) == "replied"


def test_watch_error_restarts_supervised_transport(tmp_path):
    supervisor = FakeSupervisor()
    service = IMessageService(
        config(tmp_path),
        supervisor=supervisor,
        chat_runner=lambda *_: {"response": "unused"},
    )
    service._subscription = 9
    service._on_notification("error", {"subscription": 9})
    assert supervisor.restart_calls == 1


def test_notification_cache_miss_never_reenters_rpc_reader(tmp_path):
    supervisor = FakeSupervisor()
    supervisor.chats = [{"id": 1, "guid": "iMessage;-;self", "service": "iMessage"}]
    service = IMessageService(
        config(tmp_path),
        supervisor=supervisor,
        chat_runner=lambda *_: {"response": "worker reply"},
    )

    class DeferredExecutor:
        def __init__(self):
            self.calls = []

        def submit(self, function, message):
            self.calls.append((function, message))

    service._executor.shutdown(wait=True)
    deferred = DeferredExecutor()
    service._executor = deferred
    message = owner_message(guid="DEFERRED", rowid=35)
    message.pop("service")
    service._on_notification("message", {"message": message})
    assert not [request for request in supervisor.requests if request[0] == "chats.list"]
    assert len(deferred.calls) == 1
    deferred.calls[0][0](deferred.calls[0][1])
    assert [request for request in supervisor.requests if request[0] == "chats.list"]


def test_attachment_only_message_fails_closed(tmp_path):
    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "must not run"},
    )
    message = owner_message(guid="ATTACHMENT", rowid=32, text="")
    assert service.process_message(message) == "unsupported_empty_message"


def test_remote_send_error_is_terminal_unknown_not_retried(tmp_path):
    class ErrorSupervisor(FakeSupervisor):
        def request(self, method, params=None, timeout=None):
            if method == "send":
                raise ImsgRpcError("synthetic remote error")
            return super().request(method, params, timeout)

    service = IMessageService(
        config(tmp_path),
        supervisor=ErrorSupervisor(),
        chat_runner=lambda *_: {"response": "reply"},
    )
    message = owner_message(guid="SEND-ERROR", rowid=33)
    assert service.process_message(message) == "send_unknown"
    assert service.process_message(message) == "duplicate"


def test_group_aliases_resolve_to_live_canonical_session(tmp_path):
    state = IMessageState(config(tmp_path))
    canonical = state.group_session_key("iMessage;+;group-42")
    state.bind_group_identifiers(["42", "iMessage;+;group-42"], canonical)
    assert state.named_group_audiences()["friends"] == canonical


def test_remote_same_text_never_consumes_outbound_echo(tmp_path):
    state = IMessageState(config(tmp_path))
    record = state.begin_outbound("INBOUND", "dm:test", "same text")
    state.finish_outbound(record, status="submitted")
    assert not state.consume_outbound_echo(
        "dm:test",
        guid="REMOTE",
        text="same text",
        is_from_me=False,
    )


def test_group_membership_change_creates_fresh_audience(tmp_path):
    state = IMessageState(config(tmp_path))
    original = state.group_session_key(
        "iMessage;+;family",
        ["principal:owner", "principal:friend"],
    )
    changed = state.group_session_key(
        "iMessage;+;family",
        ["principal:owner", "principal:friend", "principal:new"],
    )
    assert original != changed


def test_owner_chat_id_cannot_authorize_group_or_foreign_sender(tmp_path):
    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "must not run"},
    )
    disguised_group = group_message(guid="OWNER-GROUP", rowid=30, chat_id=1)
    disguised_group["chat_guid"] = "iMessage;-;self"
    assert service.process_message(disguised_group) == "invalid_event"

    foreign = owner_message(guid="OWNER-FOREIGN", rowid=31)
    foreign["is_from_me"] = False
    foreign["sender"] = FRIEND
    assert service.process_message(foreign) == "invalid_event"


def test_verified_owner_can_message_a_dedicated_rappter_account(tmp_path):
    service = IMessageService(
        config(tmp_path),
        supervisor=FakeSupervisor(),
        chat_runner=lambda *_: {"response": "owner reply"},
    )
    incoming = owner_message(guid="OWNER-REMOTE", rowid=34)
    incoming["is_from_me"] = False
    incoming["sender"] = OWNER
    assert service.process_message(incoming) == "replied"


def trust(
    principal,
    audience,
    kind,
    *,
    owner=False,
    groups=None,
    consent="",
    utterance="launch code private fact",
):
    value = {
        "trusted": True,
        "principal_id": principal,
        "audience_id": audience,
        "conversation_id": audience,
        "conversation_type": kind,
        "participant_ids": [principal],
        "is_owner": owner,
        "known_group_audiences": groups or {},
        "allowed_share_audiences": list((groups or {}).values()) + [audience],
        "consent_action": consent,
    }
    if consent:
        value["transport_event_id"] = "event:test"
        value["consent_capability"] = {
            "action": consent,
            "event_id": "event:test",
            "principal_id": principal,
            "audience_id": audience,
            "utterance": utterance,
            "consumed": False,
        }
    return value


def _agents_at(tmp_path):
    manager = ManageMemoryAgent()
    context = ContextMemoryAgent()
    manager.memory_file = tmp_path / "memory.json"
    context.memory_file = tmp_path / "memory.json"
    return manager, context


def test_private_memory_follows_person_but_not_group_until_consent(tmp_path):
    manager, context = _agents_at(tmp_path)
    principal = "principal:friend"
    dm = trust(principal, "dm:friend", "dm", groups={"friends": "group:friends"})
    group = trust(
        principal,
        "group:friends",
        "group",
        groups={"friends": "group:friends"},
        consent="share",
    )
    other = trust(principal, "group:other", "group", groups={"friends": "group:friends"})

    stored = json.loads(
        manager.perform(
            action="remember",
            content="the launch code is amber",
            _trusted_context=dm,
        )
    )
    memory_id = stored["memory_id"]
    direct = json.loads(context.perform(query="launch code", _trusted_context=dm))
    assert direct["memories"][0]["message"] == "the launch code is amber"
    assert "trust" not in direct["memories"][0]

    blocked = json.loads(context.perform(query="launch code", _trusted_context=group))
    assert blocked["memories"] == []
    assert blocked["familiar"] is True

    grant = json.loads(
        manager.perform(
            action="share",
            memory_id=memory_id,
            audience="current",
            _trusted_context=group,
        )
    )
    assert grant["shared_memory"] == "the launch code is amber"
    replay = json.loads(
        manager.perform(
            action="share",
            memory_id=memory_id,
            audience="current",
            _trusted_context=group,
        )
    )
    assert replay["status"] == "error"
    allowed = json.loads(context.perform(query="launch code", _trusted_context=group))
    assert allowed["memories"][0]["message"] == "the launch code is amber"
    assert json.loads(context.perform(query="launch code", _trusted_context=other))["memories"] == []

    revoke_group = trust(
        principal,
        "group:friends",
        "group",
        groups={"friends": "group:friends"},
        consent="revoke",
    )
    manager.perform(
        action="revoke",
        memory_id=memory_id,
        audience="current",
        _trusted_context=revoke_group,
    )
    assert json.loads(context.perform(query="launch code", _trusted_context=group))["memories"] == []


def test_legacy_memory_is_owner_private(tmp_path):
    manager, context = _agents_at(tmp_path)
    manager.memory_file.write_text(
        json.dumps(
            {
                "legacy": {
                    "id": "legacy",
                    "message": "legacy owner fact",
                    "theme": "fact",
                    "date": "2025-01-01",
                    "time": "00:00:00",
                }
            }
        )
    )
    owner = trust("principal:local-owner", "owner:local", "owner", owner=True)
    stranger = trust("principal:stranger", "dm:stranger", "dm")
    assert json.loads(context.perform(query="legacy", _trusted_context=owner))["memories"]
    blocked = json.loads(context.perform(query="legacy", _trusted_context=stranger))
    assert blocked["memories"] == []


def test_malformed_explicit_trust_context_fails_closed(tmp_path):
    manager, context = _agents_at(tmp_path)
    denied = json.loads(
        manager.perform(content="must not store", _trusted_context={"trusted": True})
    )
    assert denied["status"] == "error"
    assert not manager.memory_file.exists()

    manager.memory_file.write_text(
        json.dumps({"legacy": {"message": "owner only", "theme": "fact"}})
    )
    recalled = json.loads(
        context.perform(query="owner", _trusted_context={"trusted": True})
    )
    assert recalled["memories"] == []


def test_model_cannot_share_without_runtime_confirmed_consent(tmp_path):
    manager, _ = _agents_at(tmp_path)
    principal = "principal:friend"
    dm = trust(principal, "dm:friend", "dm")
    memory_id = json.loads(
        manager.perform(content="private fact", _trusted_context=dm)
    )["memory_id"]
    attempted = json.loads(
        manager.perform(
            action="share",
            memory_id=memory_id,
            audience="current",
            _trusted_context=dm,
        )
    )
    assert attempted["status"] == "error"


def test_negated_permission_never_becomes_share_consent(tmp_path):
    assert IMessageService._consent_action("you can not share that") == "revoke"
    assert IMessageService._consent_action('he said "you can share that"') == ""
    assert IMessageService._consent_action("if you could share it, what would happen?") == ""


def test_concurrent_memory_writes_are_serialized(tmp_path):
    manager, _ = _agents_at(tmp_path)
    owner = trust("principal:owner", "owner:local", "owner", owner=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda index: manager.perform(
                    content=f"concurrent fact {index}",
                    _trusted_context=owner,
                ),
                range(24),
            )
        )
    assert all(json.loads(item)["status"] == "success" for item in results)
    stored = json.loads(manager.memory_file.read_text())
    assert len(stored) == 24


def test_cross_process_memory_writes_are_serialized(tmp_path):
    memory_file = tmp_path / "memory.json"
    processes = [
        multiprocessing.Process(
            target=_memory_process_write,
            args=(str(memory_file), index),
        )
        for index in range(8)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(timeout=10)
        assert process.exitcode == 0
    assert len(json.loads(memory_file.read_text())) == 8
