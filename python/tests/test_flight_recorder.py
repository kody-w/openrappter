"""Python parity and mutation controls for Flight Recorder v1."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from collections.abc import Mapping
from pathlib import Path

import pytest

from openrappter.agents.basic_agent import BasicAgent
from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.channels.bridge import ChannelDispatchError, ProviderChannelBridge
from openrappter.cli import Assistant, CopilotProvider
from openrappter.flight_recorder import (
    FLIGHT_EVENT_SCHEMA,
    FLIGHT_EXPORT_SCHEMA,
    JS_MAX_SAFE_INTEGER,
    FlightRecorder,
    FlightRecorderCorruptionError,
    FlightRecorderError,
    FlightRecorderUnhealthyError,
    SQLiteFlightLedger,
    compute_flight_event_hash,
    ensure_flight_recorder_from_env,
    get_flight_recorder,
    normalize_flight_model_id,
    normalize_flight_session_id,
    normalize_flight_workspace_id,
    reset_flight_recorder_environment_for_tests,
    sanitize_flight_payload,
    sanitize_flight_value,
    set_flight_recorder,
    summarize_flight_error,
    verify_flight_event_hash,
    _process_is_alive,
    _load_or_create_identity_key,
    _current_process_incarnation,
    _reset_flight_recorder_after_fork,
    _reset_barrier_is_active,
    _canonical,
)
from openrappter.providers.types import ChatOptions, ProviderError, ProviderResponse

TEST_IDENTITY_KEY = "33" * 32


@pytest.fixture(autouse=True)
def isolated_global_recorder():
    reset_flight_recorder_environment_for_tests()
    yield
    reset_flight_recorder_environment_for_tests()


@pytest.fixture
def work_dir():
    path = Path.cwd() / f".flight-recorder-pytest-{uuid.uuid4().hex}"
    path.mkdir(mode=0o700)
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def in_memory_recorder(**kwargs):
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        **kwargs,
    )
    recorder.initialize()
    return recorder


def ledger_event(
    event_id,
    trace_id,
    sequence,
    timestamp,
    *,
    kind="agent.execute.completed",
    parent_id=None,
    metadata=None,
):
    status = (
        "started"
        if kind == "trace.started"
        else "error"
        if kind == "trace.failed"
        else "success"
    )
    event = {
        "schema": FLIGHT_EVENT_SCHEMA,
        "id": event_id,
        "sequence": sequence,
        "traceId": trace_id,
        "parentId": parent_id,
        "kind": kind,
        "source": "test",
        "status": status,
        "timestamp": timestamp,
        "metadata": (
            {"ownerPid": os.getpid()}
            if metadata is None and kind == "trace.started"
            else (metadata or {})
        ),
    }
    event["contentHash"] = compute_flight_event_hash(event)
    return event


def recorded_trace(
    trace_id,
    prefix,
    started_second,
    *,
    middle_kinds=(),
    terminal="trace.completed",
):
    kinds = ["trace.started", *middle_kinds]
    if terminal is not None:
        kinds.append(terminal)
    return [
        ledger_event(
            f"{prefix}-{index}",
            trace_id,
            index + 1,
            f"2026-01-01T00:00:{started_second + index:02d}.000Z",
            kind=kind,
            parent_id=None if index == 0 else f"{prefix}-0",
        )
        for index, kind in enumerate(kinds)
    ]


def test_event_shape_redaction_and_mutation_controls():
    recorder = in_memory_recorder(privacy={"recordIO": True})
    secret = f"ghp_{'z' * 32}"
    insecure_control = {"recentEdit": {"patch": f'const x = "{secret}"'}}
    assert secret in json.dumps(insecure_control)

    recorder.run_trace(
        {"traceId": "trace-a", "sessionId": "session-a", "workspaceId": "/repo"},
        lambda: recorder.record(
            {
                "kind": "context.assembled",
                "source": "test",
                "metadata": {"apiKey": secret, "ordinary": True},
                "payload": insecure_control,
            }
        ),
    )
    bundle = recorder.export_trace("trace-a")
    assert bundle["schema"] == FLIGHT_EXPORT_SCHEMA
    assert [event["sequence"] for event in bundle["events"]] == [1, 2, 3]
    assert [event["kind"] for event in bundle["events"]] == [
        "trace.started",
        "context.assembled",
        "trace.completed",
    ]
    root, context, terminal = bundle["events"]
    assert root["parentId"] is None
    assert context["parentId"] == root["id"]
    assert terminal["parentId"] == root["id"]
    assert context["schema"] == FLIGHT_EVENT_SCHEMA
    assert context["sessionId"] == normalize_flight_session_id(
        "session-a",
        TEST_IDENTITY_KEY,
    )
    assert context["workspaceId"] == normalize_flight_workspace_id("/repo")
    assert context["metadata"]["apiKey"] == "[redacted]"
    assert secret not in json.dumps(bundle)
    assert "/repo" not in json.dumps(bundle)
    assert "[redacted]" in json.dumps(context["payload"])
    assert all(verify_flight_event_hash(event) for event in bundle["events"])
    assert [
        event["sequence"]
        for event in recorder.query({"traceId": "trace-a", "order": "desc"})
    ] == [3, 2, 1]

    trace_mutation = {**context, "traceId": "trace-b"}
    payload_mutation = {**context, "payload": {"value": 2}}
    assert not verify_flight_event_hash(trace_mutation)
    assert compute_flight_event_hash(payload_mutation) != context["contentHash"]
    assert not verify_flight_event_hash(payload_mutation)


def test_counterparty_session_identifiers_are_hashed_but_queryable():
    recorder = in_memory_recorder()
    handle = "imessage:iMessage;-;+15551234567"

    recorder.run_trace(
        {"traceId": "private-session", "sessionId": handle},
        lambda: None,
    )

    events = recorder.query({"sessionId": handle})
    assert len(events) == 2
    assert {
        event["sessionId"] for event in events
    } == {normalize_flight_session_id(handle, TEST_IDENTITY_KEY)}
    assert "+15551234567" not in json.dumps(events)


def test_python_query_aliases_are_strict_and_never_fall_back_to_broad_results():
    recorder = in_memory_recorder()
    recorder.run_trace(
        {"traceId": "alice-trace", "sessionId": "alice@example.com"},
        lambda: None,
    )
    recorder.run_trace(
        {"traceId": "bob-trace", "sessionId": "bob@example.com"},
        lambda: None,
    )

    alice = recorder.query(session_id="alice@example.com")
    assert {event["traceId"] for event in alice} == {"alice-trace"}
    exported = recorder.export({"session_id": "alice@example.com"})
    assert {event["traceId"] for event in exported["events"]} == {"alice-trace"}
    with pytest.raises(TypeError, match="unexpected filter"):
        recorder.query(unknown_filter="alice@example.com")
    with pytest.raises(TypeError, match="both"):
        recorder.query(
            {
                "sessionId": "alice@example.com",
                "session_id": "alice@example.com",
            }
        )
    with pytest.raises(TypeError, match="unexpected filter"):
        recorder._ledger.query({"unknown_filter": True})


def test_matches_committed_typescript_python_golden_hash_vector():
    vector_path = Path(__file__).parents[2] / "contracts" / "flight-recorder-vector.json"
    vector = json.loads(vector_path.read_text(encoding="utf-8"))
    if vector["contentHash"] == "PENDING":
        pytest.skip("cross-runtime hash vector is awaiting its committed expected hash")
    assert compute_flight_event_hash(vector) == vector["contentHash"]
    assert verify_flight_event_hash(vector)
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    try:
        assert ledger.import_({
            "schema": FLIGHT_EXPORT_SCHEMA,
            "exportedAt": "2026-08-11T12:35:00.000Z",
            "events": [vector],
        }) == 1
        assert ledger.query({"traceId": vector["traceId"]}) == [vector]
    finally:
        ledger.close()


def test_ownership_cleanup_never_heals_corrupt_rows():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    start = ledger_event(
        "corrupt-ownership",
        "corrupt-ownership",
        1,
        "2026-01-01T00:00:00.000Z",
        kind="trace.started",
    )
    ledger.append(start)
    row = ledger._db.execute(
        "SELECT event_json FROM flight_events WHERE id = ?",
        (start["id"],),
    ).fetchone()
    tampered = json.loads(row[0])
    tampered["metadata"]["tampered"] = True
    ledger._db.execute(
        "UPDATE flight_events SET event_json = ? WHERE id = ?",
        (json.dumps(tampered), start["id"]),
    )

    with pytest.raises(FlightRecorderCorruptionError, match="integrity"):
        ledger.release_event_ownership(start["id"])
    with pytest.raises(FlightRecorderCorruptionError, match="integrity"):
        ledger.query()


def test_export_is_uncapped_while_public_query_remains_bounded():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    events = [
        ledger_event(
            f"uncapped-export-{index}",
            f"uncapped-trace-{index}",
            1,
            "2026-01-01T00:00:00.000Z",
        )
        for index in range(10_001)
    ]
    assert ledger.import_(
        {
            "schema": FLIGHT_EXPORT_SCHEMA,
            "exportedAt": "2026-01-01T00:00:00.000Z",
            "events": events,
        }
    ) == 10_001

    assert len(ledger.query()) == 10_000
    assert len(ledger.export()["events"]) == 10_001


def test_recursive_sanitizer_is_deterministic_circular_and_capped():
    shared = {"label": "shared"}
    value = {
        "TOKEN": "not-secret-shaped",
        "files": ["/repo/.env.local", "/repo/src/main.py"],
        "first": shared,
        "second": shared,
        "set": {"b", "a"},
        "nan": float("nan"),
    }
    value["self"] = value
    sanitized = sanitize_flight_value(value)
    assert sanitized == {
        "TOKEN": "[redacted]",
        "files": ["[excluded-path]", "/repo/src/main.py"],
        "first": {"label": "shared"},
        "nan": None,
        "second": {"label": "shared"},
        "self": "[circular]",
        "set": ["a", "b"],
    }
    assert sanitize_flight_value(value) == sanitized
    assert sanitize_flight_value(
        "HTTP 401: Authorization: Bearer header.payload.signature response denied"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "provider failed: client_secret=abcdefgh12345678 while connecting"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "redis://:supersecret@host/0"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "-----BEGIN DSA PRIVATE KEY-----\nZmFrZQ=="
    ) == "[redacted]"
    assert sanitize_flight_value(
        "https://example.test/path?token=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "https://example.test/path?session_token=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "https://example.test/path?%74oken=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "/callback?session_token=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "//host/path?%74oken=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        "https://example.test/cb#token=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        '{"password":"ordinary-secret",'
        '"nested":[{"token":"other-secret"}]}'
    ) == {
        "password": "[redacted]",
        "nested": [{"token": "[redacted]"}],
    }
    assert sanitize_flight_value(
        '{"password":"ordinary-private-value", trailing}'
    ) == "[redacted]"
    assert sanitize_flight_value(
        '{"value":9007199254740993}'
    ) == {"value": "9007199254740993n"}
    assert sanitize_flight_value(
        'prefix {"a":1.0,"b":1e-7}'
    ) == 'prefix {"a":1,"b":1e-7}'
    assert sanitize_flight_value(
        '{"password"\u00a0:\u00a0"unicode-space-secret", trailing}'
    ) == "[redacted]"
    escaped = (
        'HTTP 400 body="{\\"password\\":'
        '\\"escaped-secret\\"}"'
    )
    sanitized_escaped = sanitize_flight_value(escaped)
    assert "escaped-secret" not in sanitized_escaped
    assert "[redacted]" in sanitized_escaped
    unicode_escaped = (
        r'"\u007b\"password\":\"unicode-secret\"\u007d"'
    )
    sanitized_unicode = sanitize_flight_value(unicode_escaped)
    assert "unicode-secret" not in sanitized_unicode
    assert "[redacted]" in sanitized_unicode
    double_encoded = json.dumps(unicode_escaped)
    sanitized_double = sanitize_flight_value(double_encoded)
    assert "unicode-secret" not in sanitized_double
    assert "[redacted]" in sanitized_double
    primitive_secret = (
        r'"\u0067\u0068\u0070_aaaaaaaaaaaaaaaaaaaa"'
    )
    sanitized_primitive = sanitize_flight_value(primitive_secret)
    assert "aaaaaaaaaaaaaaaaaaaa" not in sanitized_primitive
    assert "[redacted]" in sanitized_primitive
    unmatched = "{" * 8_000
    assert sanitize_flight_value(unmatched) == unmatched
    assert sanitize_flight_value("{" * 70_000) == (
        "[truncated:70000]"
    )
    invoked = False

    def disabled_payload():
        nonlocal invoked
        invoked = True
        raise AssertionError("disabled payload should remain lazy")

    assert sanitize_flight_payload(
        disabled_payload,
        {"recordIO": False},
    ) is None
    assert invoked is False
    assert sanitize_flight_payload(
        ["x"] * 200_000,
        {"recordIO": True, "maxPayloadBytes": 100},
    ) == "[truncated:budget]"

    class DynamicMapping(Mapping):
        def __init__(self):
            self.reads = 0

        def __iter__(self):
            return iter(("items",))

        def __len__(self):
            return 1

        def __getitem__(self, key):
            if key != "items":
                raise KeyError(key)
            self.reads += 1
            return (
                ["safe"]
                if self.reads == 1
                else ["expanded"] * 20_000
            )

        def items(self):
            return [("items", self["items"])]

    dynamic = DynamicMapping()
    assert sanitize_flight_value(dynamic) == {"items": ["safe"]}
    assert dynamic.reads == 1
    shared_alias = ["x"] * 1_000
    aliases = [shared_alias] * 1_000
    assert sanitize_flight_value(aliases) == "[truncated:budget]"
    assert sanitize_flight_value({"ä", "z"}) == ["z", "ä"]
    assert sanitize_flight_value({1e-5, 1e-6}) == [1e-6, 1e-5]
    secret_key = "password=ordinary-secret-value"
    keyed = sanitize_flight_value(
        {
            "[redacted]": "control",
            secret_key: "sensitive",
        }
    )
    assert secret_key not in json.dumps(keyed)
    assert keyed == {
        "[redacted]": "control",
        "[redacted]#2": "[redacted]",
    }
    assert sanitize_flight_value(
        {"exact-property-secret": "value"},
        {"redactedValues": ["exact-property-secret"]},
    ) == {"[redacted]": "[redacted]"}
    assert sanitize_flight_value(
        {"prefixALPHABETAsuffix": "value"},
        {"redactedValues": ["ALPHABETA"]},
    ) == {"[redacted]": "value"}
    deeply_encoded = "%74oken"
    for _index in range(65):
        deeply_encoded = deeply_encoded.replace("%", "%25")
    assert sanitize_flight_value(
        "https://example.test/?"
        f"{deeply_encoded}=ordinary-secret-value"
    ) == "[redacted]"
    assert sanitize_flight_value(
        {
            "%5Bexcluded-path%5D": "encoded",
            "[excluded-path]": "literal",
        }
    ) == {
        "[excluded-path]": "encoded",
        "[excluded-path]#2": "literal",
    }
    assert sanitize_flight_value(
        {"%FF": 1, "ÿ": 2}
    ) == {"�": 1, "ÿ": 2}
    assert sanitize_flight_value('{"x":NaN}') == '{"x":NaN}'
    assert sanitize_flight_value('{"x":Infinity}') == '{"x":Infinity}'
    identity_key = "ab" * 32
    encoded_identity = "".join(
        f"%{ord(character):02x}"
        for character in identity_key
    )
    assert sanitize_flight_value(
        encoded_identity,
        {"redactedValues": [identity_key]},
    ) == "[redacted]"
    error_secret = "ordinary-error-secret"
    error = RuntimeError(
        f'HTTP 400: {{"password":"{error_secret}"}}'
    )
    sanitized_error = sanitize_flight_value(error)
    assert error_secret not in json.dumps(sanitized_error)
    assert "[redacted]" in json.dumps(sanitized_error)
    assert sanitize_flight_value(sanitized_error) == sanitized_error
    nested_error = sanitize_flight_value(
        RuntimeError(
            'Error: {not-json: '
            '{"password":"nested-error-secret"}}'
        )
    )
    assert "nested-error-secret" not in json.dumps(nested_error)
    assert "[redacted]" in json.dumps(nested_error)
    capped = sanitize_flight_payload(
        {"password": "x" * 2_000, "ordinary": "y" * 200},
        {"recordIO": True, "maxPayloadBytes": 80},
    )
    assert capped.startswith("[truncated:")

    token = f"ghp_{'z' * 32}"
    bearer = " ".join(("Bearer", "header.payload.signature"))
    assert sanitize_flight_value(f"é{token}") == "[redacted]"
    assert sanitize_flight_value(f"{token}é") == "[redacted]"
    assert sanitize_flight_value(f"é{bearer}") == "[redacted]"

    excluded_file = sanitize_flight_value(
        {
            "path": "/repo/.env",
            "content": "PRIVATE_VALUE=not-pattern-sensitive",
            "bytes": [1, 2, 3],
            "language": "dotenv",
        }
    )
    assert excluded_file == {
        "bytes": "[excluded-path]",
        "content": "[excluded-path]",
        "language": "dotenv",
        "path": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "path": Path("/repo/.env"),
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "path": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "sourcePath": "/repo/.env",
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "sourcePath": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "sourcePath": "/repo/%252Eenv",
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "sourcePath": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "sourcePath": (
                "vscode-remote://ssh-remote+host/"
                "home/alice/%2Eenv"
            ),
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "sourcePath": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "sourcePath": "vscode-remote://host/%ZZ/private/%2Eenv",
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "sourcePath": "[excluded-path]",
    }
    for locator in ("sourceUri", "documentPath"):
        assert sanitize_flight_value(
            {
                locator: "/repo/.env",
                "content": "PRIVATE_VALUE=ordinary",
            }
        ) == {
            "content": "[excluded-path]",
            locator: "[excluded-path]",
        }
    assert sanitize_flight_value(
        {
            "textDocument": {"uri": "file:///repo/.env"},
            "contentChanges": [
                {"text": "PRIVATE_VALUE=ordinary"}
            ],
        }
    ) == {
        "textDocument": {"uri": "[excluded-path]"},
        "contentChanges": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {"%2Eenv": "PRIVATE_VALUE=ordinary"}
    ) == {"[excluded-path]": "[excluded-path]"}
    assert sanitize_flight_value(
        {"%252Eenv": "PRIVATE_VALUE=ordinary"}
    ) == {"[excluded-path]": "[excluded-path]"}
    descriptor = {"uri": "file:///repo/.env"}
    for _depth in range(18):
        descriptor = {"nested": descriptor}
    assert sanitize_flight_value(
        {
            "descriptor": descriptor,
            "content": "PRIVATE_VALUE=ordinary",
        }
    )["content"] == "[excluded-path]"
    assert sanitize_flight_value(
        {
            "path": "/repo/.env",
            "language": {"raw": "PRIVATE_VALUE=ordinary"},
            "size": {"raw": 42},
            "content": "PRIVATE_VALUE=ordinary",
        }
    ) == {
        "content": "[excluded-path]",
        "language": "[excluded-path]",
        "path": "[excluded-path]",
        "size": "[excluded-path]",
    }
    assert sanitize_flight_value(
        {
            "name": ".env",
            "content": "PRIVATE_VALUE=ordinary",
            "contents": "PRIVATE_VALUE=second",
            "value": "PRIVATE_VALUE=third",
        }
    ) == {
        "content": "[excluded-path]",
        "contents": "[excluded-path]",
        "name": "[excluded-path]",
        "value": "[excluded-path]",
    }
    for uri in (
        "file:///repo/.env?version=1",
        "file:///repo/%2Eenv#fragment",
    ):
        assert sanitize_flight_value(
            {"uri": uri, "content": "PRIVATE_VALUE=ordinary"}
        ) == {
            "content": "[excluded-path]",
            "uri": "[excluded-path]",
        }


def test_sanitizer_redacts_secret_and_path_keys_without_collisions():
    secret_key = f"ghp_{'k' * 32}"
    path_key = "/Users/alice/.ssh/id_ed25519"
    value = {
        "[redacted]": "reserved",
        "[redacted]#2": "reserved-two",
        "[excluded-path]": "reserved-path",
        secret_key: "secret-key-value",
        path_key: "path-key-value",
        "constructor": "prototype-value",
        "apiKey": "field-value",
        "safe": "ordinary",
    }
    reversed_value = dict(reversed(list(value.items())))

    sanitized = sanitize_flight_value(value)
    assert sanitize_flight_value(reversed_value) == sanitized
    assert len(sanitized) == len(value)
    serialized = json.dumps(sanitized)
    assert secret_key not in serialized
    assert path_key not in serialized
    assert sanitized["[redacted]"] == "reserved"
    assert sanitized["[redacted]#2"] == "reserved-two"
    assert sanitized["[redacted]#3"] == "[redacted]"
    assert sanitized["[redacted]#4"] == "secret-key-value"
    assert sanitized["[excluded-path]"] == "reserved-path"
    assert sanitized["[excluded-path]#2"] == "[excluded-path]"
    assert sanitized["apiKey"] == "[redacted]"
    assert sanitized["safe"] == "ordinary"
    assert "constructor" not in sanitized

    filenames = sanitize_flight_value(
        {
            "server.p12": {"bytes": [1, 2, 3]},
            "service-account.json": {
                "client_email": "service@example.test"
            },
            "/Users/alice/client-secret.pem": {"private": "secret"},
        }
    )
    assert filenames == {
        "[excluded-path]": "[excluded-path]",
        "[excluded-path]#2": "[excluded-path]",
        "[excluded-path]#3": "[excluded-path]",
    }
    assert "service@example.test" not in json.dumps(filenames)
    assert "client-secret.pem" not in json.dumps(filenames)


def test_error_summary_is_stable_and_contains_no_raw_error_text():
    token = f"ghp_{'s' * 32}"
    bearer = "Bearer header.payload.signature"
    body = "raw upstream response body"
    message = f"HTTP 401 {bearer} token={token} body={body}"
    error = ProviderError(message)
    error.code = "ERR_PROVIDER_AUTH"
    error.status = 401

    summary = summarize_flight_error(error)
    assert summary == {
        "errorName": "ProviderError",
        "messageHash": hashlib.sha256(message.encode("utf-8")).hexdigest(),
        "messageChars": len(message),
        "errorCode": "ERR_PROVIDER_AUTH",
        "httpStatus": 401,
    }
    serialized = json.dumps(summary)
    assert token not in serialized
    assert bearer not in serialized
    assert body not in serialized
    assert message not in serialized


def test_trace_failure_hides_raw_error_by_default_and_keeps_exception_identity():
    raw_message = "trace failed with raw response body"
    original = RuntimeError(raw_message)
    recorder = in_memory_recorder()

    def fail():
        raise original

    with pytest.raises(RuntimeError) as caught:
        recorder.run_trace({"traceId": "private-error"}, fail)
    assert caught.value is original
    failed = recorder.query({"kind": "trace.failed"})[0]
    assert failed["metadata"]["messageChars"] == len(raw_message)
    assert failed["metadata"]["messageHash"] == hashlib.sha256(
        raw_message.encode("utf-8")
    ).hexdigest()
    assert "payload" not in failed
    assert raw_message not in json.dumps(failed)

    io_recorder = in_memory_recorder(privacy={"recordIO": True})
    with pytest.raises(RuntimeError) as io_caught:
        io_recorder.run_trace({"traceId": "opt-in-error"}, fail)
    assert io_caught.value is original
    io_failed = io_recorder.query({"kind": "trace.failed"})[0]
    assert io_failed["payload"]["error"]["message"] == raw_message
    assert raw_message not in json.dumps(io_failed["metadata"])


def test_ecmascript_number_canonicalization_and_safe_integer_controls():
    assert _canonical(
        {
            "a": 1e-7,
            "b": 1e20,
            "c": 1e21,
            "d": -0.0,
            "e": 1e-6,
            "f": -1e-7,
        }
    ) == (
        '{"a":1e-7,"b":100000000000000000000,"c":1e+21,'
        '"d":0,"e":0.000001,"f":-1e-7}'
    )
    assert sanitize_flight_value(
        {
            "positive": JS_MAX_SAFE_INTEGER + 1,
            "negative": -(JS_MAX_SAFE_INTEGER + 1),
            "positiveFloat": 1e20,
            "negativeFloat": -1e20,
            "scientificFloat": 1e21,
        }
    ) == {
        "negative": f"-{JS_MAX_SAFE_INTEGER + 1}n",
        "negativeFloat": "-100000000000000000000n",
        "positive": f"{JS_MAX_SAFE_INTEGER + 1}n",
        "positiveFloat": "100000000000000000000n",
        "scientificFloat": "1e+21n",
    }

    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    unsafe_metadata = ledger_event(
        "unsafe-metadata",
        "unsafe-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    unsafe_metadata["metadata"] = {"value": JS_MAX_SAFE_INTEGER + 1}
    unsafe_metadata["contentHash"] = "0" * 64
    with pytest.raises(FlightRecorderCorruptionError, match="safe integer"):
        ledger.append(unsafe_metadata)

    unsafe_sequence = ledger_event(
        "unsafe-sequence",
        "unsafe-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    unsafe_sequence["sequence"] = JS_MAX_SAFE_INTEGER + 1
    unsafe_sequence["contentHash"] = "0" * 64
    with pytest.raises(FlightRecorderCorruptionError, match="safe integer"):
        ledger.append(unsafe_sequence)

    unsafe_float = ledger_event(
        "unsafe-float",
        "unsafe-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    unsafe_float["metadata"] = {"value": 1e20}
    unsafe_float["contentHash"] = "0" * 64
    with pytest.raises(FlightRecorderCorruptionError, match="safe"):
        ledger.append(unsafe_float)

    recorder = in_memory_recorder()
    sanitized_event = recorder.record(
        {
            "traceId": "unsafe-numeric-sanitized",
            "kind": "context.assembled",
            "source": "test",
            "metadata": {"integralFloat": 1e20},
        }
    )
    assert sanitized_event["metadata"]["integralFloat"] == "100000000000000000000n"


def test_default_no_io_omits_payload():
    assert sanitize_flight_payload({"raw": "discarded"}) is None
    recorder = in_memory_recorder()
    event = recorder.record(
        {
            "traceId": "no-io",
            "kind": "agent.execute.completed",
            "source": "test",
            "metadata": {"token": "ordinary", "count": 3},
            "payload": {"rawPrompt": "must not persist"},
        }
    )
    assert "payload" not in event
    assert event["metadata"] == {"count": 3, "token": "[redacted]"}
    assert "must not persist" not in json.dumps(recorder.export_trace("no-io"))
    auto_model = recorder.record(
        {
            "traceId": "model-policy",
            "kind": "provider.attempt.started",
            "source": "test",
            "model": " AUTO ",
        }
    )
    concrete_model = recorder.record(
        {
            "traceId": "model-policy",
            "kind": "provider.attempt.completed",
            "source": "test",
            "model": " gpt-4.1 ",
        }
    )
    assert "model" not in auto_model
    assert concrete_model["model"] == "gpt-4.1"


def test_absolute_workspace_ids_match_typescript_hash_and_never_persist_raw_path():
    raw_workspace = "/Users/alice/project"
    expected = "workspace:9ae7af749ba270e5853be6ee"
    assert normalize_flight_workspace_id(raw_workspace) == expected
    assert normalize_flight_workspace_id("channel:memory") == "channel:memory"
    assert normalize_flight_workspace_id(
        "workspace:0123456789abcdef01234567"
    ) == "workspace:0123456789abcdef01234567"
    for uri_workspace in (
        "file:///Users/alice/private-project",
        "workspace:/Users/alice/private-project",
        r"workspace:C:\Users\alice\private-project",
        "workspace:%2FUsers%2Falice%2Fprivate-project",
        "workspace:%2FUsers%2Falice%2Fprivate-project%ZZ",
        "workspace:%252FUsers%252Falice%252Fprivate-project",
        "vscode-remote://ssh-remote+host/home/alice/private-project",
    ):
        normalized = normalize_flight_workspace_id(uri_workspace)
        assert re.fullmatch(r"workspace:[0-9a-f]{24}", normalized)
        assert normalized != uri_workspace

    recorder = in_memory_recorder()
    recorder.run_trace(
        {"traceId": "private-workspace", "workspaceId": raw_workspace},
        lambda: recorder.record({"kind": "context.assembled", "source": "test"}),
    )
    bundle = recorder.export_trace("private-workspace")
    assert {event["workspaceId"] for event in bundle["events"]} == {expected}
    assert raw_workspace not in json.dumps(bundle)
    assert len(recorder.query({"workspaceId": raw_workspace})) == 3
    assert len(recorder.export({"workspaceId": raw_workspace})["events"]) == 3


def test_persistent_restart_permissions_and_sequence_continuity(work_dir):
    database = work_dir / "private" / "flight.db"
    database.parent.mkdir(mode=0o755)
    first = FlightRecorder(enabled=True, database_path=database)
    first.initialize()
    assert first._ledger._db.execute(
        "PRAGMA synchronous"
    ).fetchone()[0] == 2
    first.run_trace(
        {"traceId": "continued", "sessionId": "person@example.com"},
        lambda: first.record({"kind": "phase.one", "source": "test"}),
    )

    assert stat.S_IMODE(database.stat().st_mode) == 0o600
    assert stat.S_IMODE(database.parent.stat().st_mode) == 0o755
    assert stat.S_IMODE(Path(f"{database}-wal").stat().st_mode) == 0o600
    assert stat.S_IMODE(Path(f"{database}-shm").stat().st_mode) == 0o600
    assert stat.S_IMODE(
        Path(f"{database}.identity-key").stat().st_mode
    ) == 0o600
    first.close()
    Path(f"{database}-wal").unlink(missing_ok=True)
    Path(f"{database}-shm").unlink(missing_ok=True)
    connection = sqlite3.connect(database)
    try:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert connection.execute("PRAGMA busy_timeout").fetchone()[0] == 5_000
    finally:
        connection.close()
    sidecars = (
        Path(f"{database}-wal"),
        Path(f"{database}-shm"),
    )
    sidecar_inodes = {}
    for sidecar in sidecars:
        sidecar.write_bytes(b"")
        sidecar.chmod(0o666)
        sidecar_inodes[sidecar] = sidecar.stat().st_ino

    second = FlightRecorder(enabled=True, database_path=database)
    second.initialize()
    for sidecar in sidecars:
        assert sidecar.stat().st_ino == sidecar_inodes[sidecar]
        assert stat.S_IMODE(sidecar.stat().st_mode) == 0o600
    second.run_trace(
        {"traceId": "continued", "sessionId": "person@example.com"},
        lambda: second.record({"kind": "phase.two", "source": "test"}),
    )
    events = second.export_trace("continued")["events"]
    assert [event["sequence"] for event in events] == [1, 2, 3, 4, 5, 6]
    assert len(second.query({"sessionId": "person@example.com"})) == 6
    second.close()


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink setup")
def test_symlinked_database_and_identity_key_are_rejected(work_dir):
    target = work_dir / "target.db"
    target.write_text("do not modify", encoding="utf-8")
    database = work_dir / "flight.db"
    database.symlink_to(target)
    linked = FlightRecorder(enabled=True, database_path=database)
    linked.initialize()
    assert linked.health()["initialized"] is False
    assert "regular file" in linked.health()["lastError"]
    assert target.read_text(encoding="utf-8") == "do not modify"

    database.unlink()
    first = FlightRecorder(
        enabled=True,
        database_path=database,
        identity_key="ab" * 32,
    )
    first.initialize()
    first.close()
    key_path = Path(f"{database}.identity-key")
    key_target = work_dir / "external-key"
    key_target.write_text(f"{'ab' * 32}\n", encoding="utf-8")
    key_path.unlink()
    key_path.symlink_to(key_target)
    key_linked = FlightRecorder(enabled=True, database_path=database)
    key_linked.initialize()
    assert key_linked.health()["initialized"] is False
    assert "regular file" in key_linked.health()["lastError"]

    real_parent = work_dir / "real-parent"
    real_parent.mkdir()
    parent_alias = work_dir / "parent-alias"
    parent_alias.symlink_to(real_parent, target_is_directory=True)
    parent_linked = FlightRecorder(
        enabled=True,
        database_path=parent_alias / "flight.db",
    )
    parent_linked.initialize()
    assert parent_linked.health()["initialized"] is False
    assert "symlink/reparse point" in parent_linked.health()["lastError"]

    owner_database = work_dir / "owner-flight.db"
    external_owners = work_dir / "external-owners"
    external_owners.mkdir()
    marker = external_owners / "marker.json"
    marker.write_text("do not modify", encoding="utf-8")
    Path(f"{owner_database}.owners").symlink_to(
        external_owners,
        target_is_directory=True,
    )
    owner_linked = FlightRecorder(
        enabled=True,
        database_path=owner_database,
    )
    owner_linked.initialize()
    assert owner_linked.health()["initialized"] is False
    assert "owner storage" in owner_linked.health()["lastError"]
    assert marker.read_text(encoding="utf-8") == "do not modify"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")
def test_insecure_custom_storage_parent_is_rejected(work_dir):
    directory = work_dir / "insecure-parent"
    directory.mkdir(mode=0o777)
    directory.chmod(0o777)
    recorder = FlightRecorder(
        enabled=True,
        database_path=directory / "flight.db",
    )
    recorder.initialize()

    assert recorder.health()["initialized"] is False
    assert "group/world writable" in recorder.health()["lastError"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink setup")
def test_managed_home_symlink_is_rejected_before_hardening(
    work_dir,
    monkeypatch,
):
    real_home = work_dir / "real-home"
    real_home.mkdir(mode=0o755)
    home_alias = work_dir / "home-alias"
    home_alias.symlink_to(real_home, target_is_directory=True)
    monkeypatch.setenv("HOME", str(home_alias))
    before_mode = stat.S_IMODE(real_home.stat().st_mode)

    recorder = FlightRecorder(enabled=True)
    recorder.initialize()

    assert recorder.health()["initialized"] is False
    assert "symlink/reparse point" in recorder.health()["lastError"]
    assert stat.S_IMODE(real_home.stat().st_mode) == before_mode
    assert not (real_home / ".openrappter").exists()


def test_runtime_append_uses_short_busy_budget(work_dir):
    database = work_dir / "runtime-busy" / "flight.db"
    database.parent.mkdir()
    ledger = SQLiteFlightLedger(database_path=database)
    ledger.initialize()
    start_event = ledger_event(
        "runtime-maintenance",
        "runtime-maintenance",
        1,
        "2026-01-01T00:00:00.000Z",
        kind="trace.started",
    )
    ledger.append(start_event)
    ledger.append(
        ledger_event(
            "runtime-prune-candidate",
            "runtime-prune-candidate",
            1,
            "2026-01-01T00:00:01.000Z",
        )
    )
    locker = sqlite3.connect(database, isolation_level=None)
    try:
        locker.execute("BEGIN IMMEDIATE")
        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            ledger.append(
                ledger_event(
                    "runtime-busy",
                    "runtime-busy",
                    1,
                    "2026-01-01T00:00:00.000Z",
                )
            )
        assert time.monotonic() - started < 1
        assert ledger._db.execute(
            "PRAGMA busy_timeout"
        ).fetchone()[0] == 5_000

        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            ledger.release_event_ownership(start_event["id"])
        assert time.monotonic() - started < 1

        started = time.monotonic()
        with pytest.raises(sqlite3.OperationalError, match="locked"):
            ledger.prune_runtime(0)
        assert time.monotonic() - started < 1
        assert ledger._db.execute(
            "PRAGMA busy_timeout"
        ).fetchone()[0] == 5_000
    finally:
        locker.execute("ROLLBACK")
        locker.close()
        ledger.close()


def test_clear_physically_purges_private_payload_bytes(work_dir):
    database = work_dir / "secure-clear" / "flight.db"
    database.parent.mkdir()
    ledger = SQLiteFlightLedger(database_path=database)
    ledger.initialize()
    assert ledger._db.execute("PRAGMA secure_delete").fetchone()[0] == 1
    sentinel = "PRIVATE_PAYLOAD_SENTINEL_7421"
    sample = ledger_event(
        "secure-clear-event",
        "secure-clear-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    sample["payload"] = {"value": sentinel}
    sample["contentHash"] = compute_flight_event_hash(sample)
    ledger.append(sample)

    ledger.clear()
    ledger.close()
    stored = b"".join(
        path.read_bytes()
        for path in (
            database,
            Path(f"{database}-wal"),
            Path(f"{database}-shm"),
        )
        if path.exists()
    )
    assert sentinel.encode("utf-8") not in stored


def test_replace_physically_purges_superseded_payload_bytes(work_dir):
    database = work_dir / "secure-replace" / "flight.db"
    database.parent.mkdir()
    ledger = SQLiteFlightLedger(database_path=database)
    ledger.initialize()
    sentinel = "REPLACED_PRIVATE_SENTINEL_7421"
    original = ledger_event(
        "secure-replace-event",
        "secure-replace-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    original["payload"] = {"value": sentinel}
    original["contentHash"] = compute_flight_event_hash(original)
    replacement = dict(original)
    replacement["payload"] = {"value": "removed"}
    replacement["contentHash"] = compute_flight_event_hash(replacement)
    ledger.append(original)
    ledger.import_(
        {
            "schema": FLIGHT_EXPORT_SCHEMA,
            "exportedAt": "2026-01-01T00:00:01.000Z",
            "events": [replacement],
        },
        replace=True,
    )
    ledger.close()

    stored = b"".join(
        path.read_bytes()
        for path in (
            database,
            Path(f"{database}-wal"),
            Path(f"{database}-shm"),
        )
        if path.exists()
    )
    assert sentinel.encode("utf-8") not in stored


def test_empty_identity_key_is_recovered_atomically(work_dir):
    database = work_dir / "empty-key" / "flight.db"
    database.parent.mkdir()
    key_path = Path(f"{database}.identity-key")
    key_path.write_text("", encoding="utf-8")
    recorder = FlightRecorder(enabled=True, database_path=database)
    recorder.initialize()
    recorder.run_trace(
        {"traceId": "recovered-key", "sessionId": "person@example.com"},
        lambda: None,
    )

    assert re.fullmatch(
        r"[0-9a-f]{64}",
        key_path.read_text(encoding="utf-8").strip(),
    )
    assert recorder.export_trace("recovered-key")["events"][0][
        "sessionId"
    ].startswith("session:")


def test_identity_key_io_handles_short_reads_and_writes(work_dir, monkeypatch):
    database = work_dir / "short-key-io" / "flight.db"
    database.parent.mkdir()
    real_write = os.write
    real_read = os.read

    def short_write(descriptor, data):
        return real_write(descriptor, bytes(data[:3]))

    def short_read(descriptor, count):
        return real_read(descriptor, min(count, 2))

    monkeypatch.setattr(os, "write", short_write)
    monkeypatch.setattr(os, "read", short_read)
    key = _load_or_create_identity_key(str(database))

    persisted = Path(f"{database}.identity-key").read_text(
        encoding="utf-8"
    ).strip()
    assert re.fullmatch(r"[0-9a-f]{64}", key)
    assert persisted == key


def test_explicit_identity_key_is_persisted_and_mismatch_rejected(work_dir):
    database = work_dir / "explicit-key" / "flight.db"
    database.parent.mkdir()
    explicit = "ab" * 32
    first = FlightRecorder(
        enabled=True,
        database_path=database,
        identity_key=explicit,
    )
    second = FlightRecorder(enabled=True, database_path=database)
    mismatch = FlightRecorder(
        enabled=True,
        database_path=database,
        identity_key="cd" * 32,
    )
    try:
        first.initialize()
        first.run_trace(
            {
                "traceId": "explicit-key-first",
                "sessionId": "same-person",
            },
            lambda: None,
        )
        assert Path(f"{database}.identity-key").read_text(
            encoding="utf-8"
        ).strip() == explicit

        second.initialize()
        second.run_trace(
            {
                "traceId": "explicit-key-second",
                "sessionId": "same-person",
            },
            lambda: None,
        )
        first_session = first.export_trace(
            "explicit-key-first"
        )["events"][0]["sessionId"]
        second_session = second.export_trace(
            "explicit-key-second"
        )["events"][0]["sessionId"]
        assert second_session == first_session

        mismatch.initialize()
        assert mismatch.health()["initialized"] is False
        assert "does not match the persisted key" in (
            mismatch.health()["lastError"]
        )
        first.close()
        second.close()
        Path(f"{database}.identity-key").unlink()
        missing = FlightRecorder(
            enabled=True,
            database_path=database,
        )
        try:
            missing.initialize()
            assert missing.health()["initialized"] is False
            assert "missing for a non-empty ledger" in (
                missing.health()["lastError"]
            )
        finally:
            missing.close()
    finally:
        first.close()
        second.close()
        mismatch.close()


def test_identity_key_is_bound_to_ledger_fingerprint(work_dir):
    database = work_dir / "key-binding" / "flight.db"
    database.parent.mkdir()
    first = FlightRecorder(
        enabled=True,
        database_path=database,
        identity_key="12" * 32,
    )
    first.initialize()
    first.run_trace({"traceId": "bound-key"}, lambda: None)
    first.close()

    Path(f"{database}.identity-key").write_text(
        f"{'34' * 32}\n",
        encoding="utf-8",
    )
    second = FlightRecorder(enabled=True, database_path=database)
    try:
        second.initialize()
        assert second.health()["initialized"] is False
        assert "ledger fingerprint" in second.health()["lastError"]
    finally:
        second.close()


def test_active_identity_key_and_sidecar_aliases_are_always_redacted():
    identity_key = "ef" * 32
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=identity_key,
        privacy={"recordIO": True},
    )
    recorder.initialize()
    recorder.record(
        {
            "traceId": "identity-key-redaction",
            "kind": "identity.probe",
            "source": "test",
            "metadata": {
                "identityKey": identity_key,
                "OPENRAPPTER_FLIGHT_ID_KEY": identity_key,
                "assignment": (
                    f"OPENRAPPTER_FLIGHT_ID_KEY={identity_key}"
                ),
                "path": "/tmp/flight.db.identity-key",
            },
            "payload": {"raw": identity_key},
        }
    )
    recorder.record(
        {
            "traceId": "identity-kind-redaction",
            "kind": identity_key.upper(),
            "source": "test",
        }
    )

    serialized = json.dumps(recorder.export())
    assert identity_key not in serialized
    assert identity_key.upper() not in serialized
    assert "flight.db.identity-key" not in serialized
    assert "[redacted]" in serialized
    assert "[excluded-path]" in serialized


def test_exact_privacy_precedes_opaque_identifier_passthrough():
    provider_id = f"provider:{'a' * 24}"
    session_id = f"session:{'b' * 24}"
    workspace_id = f"workspace:{'c' * 24}"
    recorder = in_memory_recorder(
        privacy={
            "redactedValues": [
                provider_id,
                session_id,
                workspace_id,
            ]
        }
    )

    def record_probe():
        recorder.record(
            {
                "kind": "opaque.probe",
                "source": "test",
                "providerId": provider_id,
            }
        )

    recorder.run_trace(
        {
            "traceId": "opaque-redaction",
            "sessionId": session_id,
            "workspaceId": workspace_id,
        },
        record_probe,
    )
    events = recorder.query({"traceId": "opaque-redaction"})
    probe = next(
        event for event in events if event["kind"] == "opaque.probe"
    )
    assert re.fullmatch(r"provider:[0-9a-f]{24}", probe["providerId"])
    assert probe["providerId"] != provider_id
    assert re.fullmatch(r"session:[0-9a-f]{24}", probe["sessionId"])
    assert probe["sessionId"] != session_id
    assert re.fullmatch(
        r"workspace:[0-9a-f]{24}",
        probe["workspaceId"],
    )
    assert probe["workspaceId"] != workspace_id
    assert provider_id not in json.dumps(events)
    assert len(recorder.query({"sessionId": session_id})) == len(events)


def test_sequence_allocation_uses_private_trace_lookup(monkeypatch):
    ledger = SQLiteFlightLedger(in_memory=True)
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        retention_events=-1,
        ledger=ledger,
    )
    recorder.initialize()
    monkeypatch.setattr(
        ledger,
        "query",
        lambda *_args, **_kwargs: (
            _ for _ in ()
        ).throw(RuntimeError("public query must not run")),
    )

    recorder.run_trace({"traceId": "private-sequence"}, lambda: None)
    recorder.run_trace({"traceId": "private-sequence"}, lambda: None)

    assert ledger.last_sequence("private-sequence") == 4


def test_reentrant_close_and_clear_reject_before_pending_wait():
    recorder = in_memory_recorder(retention_events=-1)
    entered = threading.Event()
    resume = threading.Event()

    def active_operation():
        entered.set()
        assert resume.wait(timeout=2)
        with pytest.raises(FlightRecorderError, match="active trace"):
            recorder.close()
        with pytest.raises(FlightRecorderError, match="active trace"):
            recorder.clear()

    with ThreadPoolExecutor(max_workers=2) as pool:
        trace = pool.submit(
            recorder.run_trace,
            {"traceId": "reentrant-shutdown"},
            active_operation,
        )
        assert entered.wait(timeout=2)
        closing = pool.submit(recorder.close)
        deadline = time.time() + 2
        while not recorder._closing and time.time() < deadline:
            time.sleep(0.005)
        assert recorder._closing is True
        resume.set()
        trace.result(timeout=2)
        closing.result(timeout=2)


def test_detached_async_work_is_re_rooted_after_trace_completion():
    import asyncio

    recorder = in_memory_recorder(retention_events=-1)

    async def scenario():
        gate = asyncio.Event()
        detached = None

        async def record_later():
            await gate.wait()
            return recorder.record(
                {"kind": "detached.event", "source": "test"}
            )

        def operation():
            nonlocal detached
            detached = asyncio.create_task(record_later())

        recorder.run_trace({"traceId": "detached-origin"}, operation)
        gate.set()
        return await detached

    detached_event = asyncio.run(scenario())
    assert detached_event is not None
    assert detached_event["traceId"] != "detached-origin"
    assert detached_event["parentId"] is None
    assert [
        event["kind"]
        for event in recorder.query({"traceId": "detached-origin"})
    ] == ["trace.started", "trace.completed"]


def test_async_run_trace_awaits_body_and_records_terminal_outcome():
    import asyncio

    recorder = in_memory_recorder(retention_events=-1)

    async def scenario():
        async def succeed():
            await asyncio.sleep(0)
            recorder.record({"kind": "async.body", "source": "test"})
            return "done"

        assert await recorder.run_trace(
            {"traceId": "async-success"},
            succeed,
        ) == "done"

        async def fail():
            await asyncio.sleep(0)
            recorder.record(
                {"kind": "async.before-failure", "source": "test"}
            )
            raise ValueError("async failure")

        with pytest.raises(ValueError, match="async failure"):
            await recorder.run_trace(
                {"traceId": "async-failure"},
                fail,
            )

    asyncio.run(scenario())
    assert [
        event["kind"]
        for event in recorder.query({"traceId": "async-success"})
    ] == ["trace.started", "async.body", "trace.completed"]
    assert [
        event["kind"]
        for event in recorder.query({"traceId": "async-failure"})
    ] == [
        "trace.started",
        "async.before-failure",
        "trace.failed",
    ]


def test_async_with_parent_preserves_supplied_parent():
    import asyncio

    recorder = in_memory_recorder(retention_events=-1)

    async def scenario():
        async def operation():
            parent = recorder.record(
                {"kind": "async.parent", "source": "test"}
            )

            async def child():
                await asyncio.sleep(0)
                return recorder.record(
                    {"kind": "async.child", "source": "test"}
                )

            return await recorder.with_parent(parent["id"], child)

        return await recorder.run_trace(
            {"traceId": "async-parent"},
            operation,
        )

    child = asyncio.run(scenario())
    events = recorder.query({"traceId": "async-parent"})
    parent = next(
        event for event in events if event["kind"] == "async.parent"
    )
    assert child["parentId"] == parent["id"]


def test_async_close_and_clear_do_not_block_the_event_loop():
    import asyncio

    async def close_scenario():
        recorder = in_memory_recorder(retention_events=-1)
        entered = asyncio.Event()

        async def operation():
            entered.set()
            await asyncio.sleep(0.05)

        trace = asyncio.create_task(
            recorder.run_trace(
                {"traceId": "async-close"},
                operation,
            )
        )
        await entered.wait()
        with pytest.raises(FlightRecorderError, match="aclose"):
            recorder.close()
        await recorder.aclose()
        await trace
        assert recorder.health()["initialized"] is False

    async def clear_scenario():
        recorder = in_memory_recorder(retention_events=-1)
        entered = asyncio.Event()

        async def operation():
            entered.set()
            await asyncio.sleep(0.05)

        trace = asyncio.create_task(
            recorder.run_trace(
                {"traceId": "async-clear"},
                operation,
            )
        )
        await entered.wait()
        with pytest.raises(FlightRecorderError, match="aclear"):
            recorder.clear()
        assert await recorder.aclear() is True
        await trace
        assert recorder.health()["eventCount"] == 0

    asyncio.run(close_scenario())
    asyncio.run(clear_scenario())


def test_trace_setup_errors_do_not_leak_active_operation_count():
    recorder = in_memory_recorder()
    with pytest.raises(TypeError):
        recorder.run_trace(
            {"traceId": object()},
            lambda: None,
        )
    assert recorder._active_trace_operations == 0
    assert recorder.run_trace(
        {"traceId": "numeric-session", "sessionId": 12345},
        lambda: "ok",
    ) == "ok"
    recorder.close()


def test_lone_unicode_surrogate_session_is_normalized_fail_open():
    recorder = in_memory_recorder()
    ran = False

    def operation():
        nonlocal ran
        ran = True

    recorder.run_trace(
        {"traceId": "unicode-session", "sessionId": "\ud800"},
        operation,
    )
    events = recorder.query({"traceId": "unicode-session"})
    assert ran is True
    assert len(events) == 2
    assert re.fullmatch(
        r"session:[0-9a-f]{24}",
        events[0]["sessionId"],
    )
    assert recorder.health()["errorCount"] == 0
    structural = recorder.record(
        {
            "traceId": "bad\ud800",
            "kind": "unicode.identifier",
            "source": "test",
        }
    )
    assert structural["traceId"] == "bad\ufffd"
    assert sanitize_flight_value(
        {"value": "\ud800"}
    ) == {"value": "\ufffd"}
    first_order = sanitize_flight_value(
        {"\ud800": "first", "\ufffd": "second"}
    )
    second_order = sanitize_flight_value(
        {"\ufffd": "second", "\ud800": "first"}
    )
    assert first_order == second_order == {
        "\ufffd": "first",
        "\ufffd#2": "second",
    }


def test_custom_privacy_applies_to_structural_identifiers_except_kind():
    recorder = in_memory_recorder(
        privacy={
            "excludedPathPatterns": [
                re.compile(r"secret|custom\.kind", re.I)
            ],
            "redactedKeys": [
                "id",
                "traceId",
                "source",
                "parentId",
            ],
        }
    )

    def record_custom():
        recorder.record(
            {
                "kind": "custom.kind",
                "source": "secret-source",
                "parentId": "secret-parent",
            }
        )

    recorder.run_trace(
        {"traceId": "secret-trace-customer-123"},
        record_custom,
    )
    events = recorder.query(
        {"traceId": "secret-trace-customer-123"}
    )
    custom = next(
        event for event in events
        if event["kind"] == "custom.kind"
    )
    assert re.fullmatch(r"trace:[0-9a-f]{24}", custom["traceId"])
    assert re.fullmatch(r"source:[0-9a-f]{24}", custom["source"])
    assert re.fullmatch(r"event:[0-9a-f]{24}", custom["parentId"])
    assert all(
        re.fullmatch(r"event:[0-9a-f]{24}", event["id"])
        for event in events
    )
    assert len(recorder.query({"source": "secret-source"})) == 1
    assert "secret-" not in json.dumps(events)


def test_lifecycle_kinds_remain_non_redactable_for_active_retention():
    recorder = in_memory_recorder(
        retention_events=0,
        privacy={"redactedValues": ["trace"]},
    )

    def operation():
        recorder.record(
            {"kind": "inside.lifecycle", "source": "test"}
        )
        active = recorder.query({"traceId": "private-lifecycle"})
        assert [event["kind"] for event in active] == [
            "trace.started",
            "inside.lifecycle",
        ]

    recorder.run_trace({"traceId": "private-lifecycle"}, operation)


def test_displayed_private_trace_ids_stay_stable_for_query_and_import():
    recorder = in_memory_recorder(
        privacy={"redactedValues": ["trace"]},
    )

    def operation():
        recorder.record({"kind": "stable.event", "source": "test"})

    recorder.run_trace({"traceId": "private-stable-trace"}, operation)
    exported = recorder.export()
    displayed_trace_id = exported["events"][0]["traceId"]

    assert len(
        recorder.query({"traceId": displayed_trace_id})
    ) == len(exported["events"])
    assert recorder.import_(
        exported,
        replace=True,
    ) == len(exported["events"])


def test_fail_open_error_formatting_survives_hostile_str():
    class HostileError(Exception):
        def __str__(self):
            raise RuntimeError("stringification failed")

    class HostileLedger:
        def initialize(self):
            pass

        def append(self, _event):
            raise HostileError()

        def close(self):
            pass

        def count(self):
            return 0

        def query(self, *_args, **_kwargs):
            return []

        def prune(self, _keep):
            return 0

    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        ledger=HostileLedger(),
    )
    recorder.initialize()

    assert recorder.record(
        {"kind": "hostile.error", "source": "test"}
    ) is None
    assert recorder.health()["lastError"] == (
        "HostileError: [unavailable]"
    )


def test_hostile_error_traversal_still_records_terminal_failure():
    class HostileError(Exception):
        @property
        def code(self):
            raise RuntimeError("blocked code")

        def __str__(self):
            raise RuntimeError("blocked stringification")

    recorder = in_memory_recorder(privacy={"recordIO": True})
    hostile = HostileError()
    with pytest.raises(HostileError) as caught:
        recorder.run_trace(
            {"traceId": "hostile-terminal"},
            lambda: (_ for _ in ()).throw(hostile),
        )
    assert caught.value is hostile
    assert [
        event["kind"]
        for event in recorder.query({"traceId": "hostile-terminal"})
    ] == ["trace.started", "trace.failed"]


def test_health_survives_post_initialization_count_failure():
    recorder = in_memory_recorder()

    def fail_count():
        raise RuntimeError("count failed")

    recorder._ledger.count = fail_count
    health = recorder.health()

    assert health["initialized"] is True
    assert health["eventCount"] == 0
    assert health["errorCount"] >= 1
    assert "count failed" in health["lastError"]


def test_stale_reset_barrier_is_reclaimed(work_dir):
    database = work_dir / "stale-reset" / "flight.db"
    database.parent.mkdir()
    Path(f"{database}.reset-lock").write_text(
        "2147483647\n",
        encoding="utf-8",
    )
    recorder = FlightRecorder(enabled=True, database_path=database)
    recorder.initialize()

    assert recorder.health()["initialized"] is True
    assert not Path(f"{database}.reset-lock").exists()


def test_initialization_retry_reregisters_owner(work_dir, monkeypatch):
    database = work_dir / "retry-owner" / "flight.db"
    database.parent.mkdir()
    original_initialize = SQLiteFlightLedger.initialize
    attempts = {"count": 0}

    def fail_once(ledger):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("transient initialize failure")
        return original_initialize(ledger)

    monkeypatch.setattr(SQLiteFlightLedger, "initialize", fail_once)
    recorder = FlightRecorder(enabled=True, database_path=database)
    recorder.initialize()
    assert recorder.health()["initialized"] is False
    recorder._next_initialization_attempt_at = 0
    recorder.initialize()

    owners = list(Path(f"{database}.owners").glob("*.json"))
    assert recorder.health()["initialized"] is True
    assert len(owners) == 1


def test_concurrent_close_callers_wait_for_same_cleanup():
    class SlowCloseLedger(SQLiteFlightLedger):
        def __init__(self):
            super().__init__(in_memory=True)
            self.entered = threading.Event()
            self.release = threading.Event()

        def close(self):
            self.entered.set()
            self.release.wait(timeout=5)
            return super().close()

    ledger = SlowCloseLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        ledger=ledger,
    )
    recorder.initialize()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(recorder.close)
        assert ledger.entered.wait(timeout=5)
        second = pool.submit(recorder.close)
        time.sleep(0.02)
        assert not second.done()
        ledger.release.set()
        first.result(timeout=5)
        second.result(timeout=5)


def test_exact_export_import_and_atomic_hash_tamper_refusal():
    source = in_memory_recorder(privacy={"recordIO": True})
    source.record(
        {
            "traceId": "portable",
            "kind": "tool.call.completed",
            "source": "test",
            "payload": {"answer": 42},
        }
    )
    exported = source.export()
    assert "ownerPid" not in exported["events"][0]["metadata"]
    assert source.import_(exported) == 0
    destination = SQLiteFlightLedger(in_memory=True)
    destination.initialize()
    assert destination.import_(exported) == 1
    assert destination.query() == exported["events"]

    tampered = copy.deepcopy(exported)
    tampered["events"].append(copy.deepcopy(exported["events"][0]))
    tampered["events"][1]["id"] = "tampered-id"
    tampered["events"][1]["traceId"] = "tampered-trace"
    with pytest.raises(FlightRecorderCorruptionError, match="integrity"):
        destination.import_(tampered)
    assert destination.count() == 1


def test_import_rejects_hash_valid_privacy_violations():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    unsafe_cases = [
        ledger_event(
            f"unsafe-{index}",
            f"unsafe-trace-{index}",
            1,
            "2026-01-01T00:00:00.000Z",
        )
        for index in range(4)
    ]
    unsafe_cases[0]["sessionId"] = "alice@example.com"
    unsafe_cases[1]["workspaceId"] = "/Users/alice/private"
    unsafe_cases[2]["metadata"] = {"authorization": "raw-secret"}
    unsafe_cases[3]["payload"] = {"token": "raw-token"}
    for index, raw_workspace in enumerate(
        (
            "file:///Users/alice/private",
            "workspace:/Users/alice/private",
            r"workspace:C:\Users\alice\private",
        ),
        start=len(unsafe_cases),
    ):
        unsafe = ledger_event(
            f"unsafe-{index}",
            f"unsafe-trace-{index}",
            1,
            "2026-01-01T00:00:00.000Z",
        )
        unsafe["workspaceId"] = raw_workspace
        unsafe_cases.append(unsafe)
    forged_owner = ledger_event(
        "unsafe-owner",
        "unsafe-owner-trace",
        1,
        "2026-01-01T00:00:00.000Z",
        kind="trace.started",
        metadata={"ownerPid": os.getpid()},
    )
    unsafe_cases.append(forged_owner)
    for event in unsafe_cases:
        event["contentHash"] = compute_flight_event_hash(event)
        with pytest.raises(
            FlightRecorderCorruptionError,
            match="privacy|opaque session|raw path|live trace ownership",
        ):
            ledger.import_(
                {
                    "schema": FLIGHT_EXPORT_SCHEMA,
                    "exportedAt": "2026-01-01T00:00:00.000Z",
                    "events": [event],
                }
            )
    assert ledger.count() == 0


def test_import_rejects_secret_shaped_top_level_fields():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    token = f"ghp_{'x' * 32}"
    invalid = ledger_event(
        "top-level-secret",
        "top-level-secret-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    invalid["providerId"] = token
    invalid["contentHash"] = compute_flight_event_hash(invalid)

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="providerId.*privacy",
    ):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:00.000Z",
                "events": [invalid],
            }
        )

    secret_id = ledger_event(
        token,
        "secret-id-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    with pytest.raises(
        FlightRecorderCorruptionError,
        match="id.*privacy",
    ):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:00.000Z",
                "events": [secret_id],
            }
        )


def test_import_rejects_conflicting_duplicate_ids():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    original = ledger_event(
        "duplicate-id",
        "duplicate-original",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    conflicting = ledger_event(
        "duplicate-id",
        "duplicate-conflict",
        1,
        "2026-01-01T00:00:01.000Z",
    )
    ledger.append(original)

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="conflicts with existing content",
    ):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:02.000Z",
                "events": [conflicting],
            }
        )


def test_multi_row_replace_stages_swapped_sequences():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    first = ledger_event(
        "swap-a",
        "swap-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    second = ledger_event(
        "swap-b",
        "swap-trace",
        2,
        "2026-01-01T00:00:01.000Z",
    )
    ledger.append(first)
    ledger.append(second)
    swapped_a = dict(first)
    swapped_a["sequence"] = 2
    swapped_a["contentHash"] = compute_flight_event_hash(swapped_a)
    swapped_b = dict(second)
    swapped_b["sequence"] = 1
    swapped_b["contentHash"] = compute_flight_event_hash(swapped_b)

    assert ledger.import_(
        {
            "schema": FLIGHT_EXPORT_SCHEMA,
            "exportedAt": "2026-01-01T00:00:02.000Z",
            "events": [swapped_a, swapped_b],
        },
        replace=True,
    ) == 2
    assert [
        (event["id"], event["sequence"])
        for event in ledger.query({"traceId": "swap-trace"})
    ] == [("swap-b", 1), ("swap-a", 2)]


def test_import_validates_existing_ledger_before_mutation():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    ledger.append(
        ledger_event(
            "existing-corrupt",
            "existing-corrupt-trace",
            1,
            "2026-01-01T00:00:00.000Z",
        )
    )
    ledger._db.execute(
        "UPDATE flight_events SET event_json = ? WHERE id = ?",
        ("{bad", "existing-corrupt"),
    )
    incoming = ledger_event(
        "unrelated-import",
        "unrelated-import-trace",
        1,
        "2026-01-01T00:00:01.000Z",
    )

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="not valid JSON",
    ):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:02.000Z",
                "events": [incoming],
            }
        )
    assert ledger.count() == 1


def test_import_rejects_auto_as_concrete_model():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    invalid = ledger_event(
        "auto-model",
        "auto-model-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    invalid["model"] = "auto"
    invalid["contentHash"] = compute_flight_event_hash(invalid)

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="concrete normalized model",
    ):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:00.000Z",
                "events": [invalid],
            }
        )


def test_import_rejects_payload_when_record_io_is_disabled():
    source = in_memory_recorder(privacy={"recordIO": True})
    source.record(
        {
            "traceId": "payload-import",
            "kind": "payload",
            "source": "test",
            "payload": {"ordinary": "private"},
        }
    )
    target = in_memory_recorder(privacy={"recordIO": False})

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="recordIO is disabled",
    ):
        target.import_(source.export_trace("payload-import"))


def test_import_applies_custom_redaction_policy():
    source = in_memory_recorder()
    source.record(
        {
            "traceId": "custom-policy-import",
            "kind": "metadata",
            "source": "test",
            "metadata": {"customerData": "raw-value"},
        }
    )
    target = in_memory_recorder(
        privacy={"redactedKeys": ["customerData"]}
    )

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="active privacy policy",
    ):
        target.import_(source.export_trace("custom-policy-import"))


def test_import_applies_custom_policy_to_top_level_identifiers():
    source = in_memory_recorder()
    source.record(
        {
            "traceId": "sensitive-trace",
            "kind": "ordinary",
            "source": "test",
            "providerId": "internal-provider",
        }
    )
    target = in_memory_recorder(
        privacy={
            "excludedPathPatterns": [
                re.compile(r"sensitive|internal", re.I)
            ]
        }
    )

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="active privacy policy",
    ):
        target.import_(source.export_trace("sensitive-trace"))

    key_target = in_memory_recorder(
        privacy={"redactedKeys": ["providerId"]}
    )
    with pytest.raises(
        FlightRecorderCorruptionError,
        match="active privacy policy",
    ):
        key_target.import_(source.export_trace("sensitive-trace"))


def test_custom_key_policy_applies_to_recorded_envelope_fields():
    recorder = in_memory_recorder(
        privacy={"redactedKeys": ["providerId"]}
    )
    event = recorder.record(
        {
            "traceId": "custom-envelope-key",
            "kind": "ordinary",
            "source": "test",
            "providerId": "internal-provider",
        }
    )

    assert event["providerId"].startswith("provider:")
    assert "internal-provider" not in json.dumps(event)


def test_structural_lifecycle_fields_are_reserved_from_custom_key_policy():
    recorder = in_memory_recorder(
        privacy={
            "redactedKeys": [
                "traceId",
                "parentId",
                "kind",
                "source",
            ]
        }
    )
    recorder.run_trace({"traceId": "structural-trace"}, lambda: None)
    events = recorder.query({"traceId": "structural-trace"})
    assert [event["kind"] for event in events] == [
        "trace.started",
        "trace.completed",
    ]
    assert recorder.clear() is True


def test_identifier_pseudonyms_are_idempotent_across_import():
    source = in_memory_recorder(
        privacy={"redactedKeys": ["providerId"]}
    )
    source.record(
        {
            "traceId": "idempotent",
            "kind": "ordinary",
            "source": "test",
            "providerId": "internal-provider",
        }
    )
    bundle = source.export_trace("idempotent")
    provider_id = bundle["events"][0]["providerId"]
    target = in_memory_recorder(
        privacy={"redactedKeys": ["providerId"]}
    )

    target.import_(bundle)
    assert (
        target.export_trace("idempotent")["events"][0]["providerId"]
        == provider_id
    )


def test_normalized_trace_ids_do_not_leak_sequence_cache():
    recorder = in_memory_recorder(
        privacy={
            "excludedPathPatterns": [
                re.compile(r"secret-trace", re.I)
            ]
        }
    )
    for index in range(20):
        recorder.run_trace(
            {"traceId": f"secret-trace-{index}"},
            lambda: None,
        )
    assert recorder._sequence_by_trace == {}


def test_configured_payload_cap_above_default_is_honored():
    recorder = in_memory_recorder(
        privacy={"recordIO": True, "maxPayloadBytes": 30_000}
    )
    event = recorder.record(
        {
            "traceId": "large-configured-payload",
            "kind": "payload",
            "source": "test",
            "payload": {"value": "x" * 20_000},
        }
    )

    assert event is not None
    assert recorder.count() == 1


def test_terminal_failure_releases_start_ownership():
    class TerminalFailLedger(SQLiteFlightLedger):
        def __init__(self):
            super().__init__(in_memory=True)

        def append(self, event):
            if event["kind"] == "trace.completed":
                raise RuntimeError("terminal append failed")
            return super().append(event)

    ledger = TerminalFailLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        retention_events=-1,
        ledger=ledger,
    )
    recorder.initialize()
    assert recorder.run_trace(
        {"traceId": "terminal-failure"},
        lambda: "success",
    ) == "success"
    events = recorder.query({"traceId": "terminal-failure"})
    assert "ownerPid" not in events[0]["metadata"]
    assert recorder.clear() is True


def test_failed_nested_start_does_not_terminate_ancestor():
    class FailSecondAppendLedger(SQLiteFlightLedger):
        def __init__(self):
            super().__init__(in_memory=True)
            self.attempts = 0

        def append(self, event):
            self.attempts += 1
            if self.attempts == 2:
                raise RuntimeError("nested start append failed")
            return super().append(event)

    ledger = FailSecondAppendLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        retention_events=-1,
        ledger=ledger,
    )
    recorder.initialize()

    def run_nested():
        def nested_operation():
            recorder.record({"kind": "nested.work", "source": "test"})
            return "nested result"

        assert recorder.run_trace({}, nested_operation) == "nested result"
        active = recorder.query({"traceId": "nested-start-failure"})
        assert [event["kind"] for event in active] == [
            "trace.started",
            "nested.work",
        ]
        assert active[1]["parentId"] is None

    recorder.run_trace(
        {"traceId": "nested-start-failure"},
        run_nested,
    )
    events = recorder.query({"traceId": "nested-start-failure"})
    assert [event["kind"] for event in events] == [
        "trace.started",
        "nested.work",
        "trace.completed",
    ]
    assert events[2]["parentId"] == events[0]["id"]


def test_cancelled_trace_releases_ownership():
    import asyncio

    recorder = in_memory_recorder()
    with pytest.raises(asyncio.CancelledError):
        recorder.run_trace(
            {"traceId": "cancelled-trace"},
            lambda: (_ for _ in ()).throw(asyncio.CancelledError()),
        )

    assert recorder.clear() is True


def test_explicit_prune_failure_is_raised():
    class PruneFailureLedger(SQLiteFlightLedger):
        def prune(self, _keep):
            raise RuntimeError("checkpoint failed")

    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        ledger=PruneFailureLedger(in_memory=True),
    )
    recorder.initialize()
    with pytest.raises(RuntimeError, match="checkpoint failed"):
        recorder.prune(0)


def test_replace_import_preserves_live_trace_ownership():
    recorder = in_memory_recorder(retention_events=0)

    def replace_inside_trace():
        bundle = recorder.export_trace("replace-active")
        assert "ownerPid" not in bundle["events"][0]["metadata"]
        altered = copy.deepcopy(bundle)
        altered["events"][0]["sessionId"] = (
            "session:111111111111111111111111"
        )
        altered["events"][0]["workspaceId"] = (
            "workspace:222222222222222222222222"
        )
        altered["events"][0]["metadata"]["scopeChanged"] = True
        altered["events"][0]["contentHash"] = (
            compute_flight_event_hash(altered["events"][0])
        )
        with pytest.raises(
            FlightRecorderCorruptionError,
            match="live trace|portable content",
        ):
            recorder.import_(altered, replace=True)
        assert recorder.import_(bundle, replace=True) == len(
            bundle["events"]
        )
        recorder.record({"kind": "inside-active", "source": "test"})
        assert any(
            event["kind"] == "trace.started"
            for event in recorder.query({"traceId": "replace-active"})
        )

    recorder.run_trace({"traceId": "replace-active"}, replace_inside_trace)


def test_replace_completed_trace_does_not_restore_start_ownership():
    recorder = in_memory_recorder(retention_events=-1)
    recorder.run_trace({"traceId": "replace-completed"}, lambda: None)
    bundle = recorder.export_trace("replace-completed")

    assert recorder.import_(bundle, replace=True) == len(bundle["events"])
    start = next(
        event
        for event in recorder.query({"traceId": "replace-completed"})
        if event["kind"] == "trace.started"
    )
    assert "ownerPid" not in start["metadata"]
    assert "ownerIncarnation" not in start["metadata"]


def test_import_cannot_terminate_a_live_trace():
    recorder = in_memory_recorder(retention_events=0)

    def import_terminal():
        root = next(
            event
            for event in recorder.query({"traceId": "live-import"})
            if event["kind"] == "trace.started"
        )
        terminal = ledger_event(
            "forged-terminal",
            root["traceId"],
            root["sequence"] + 1,
            "2026-01-01T00:00:01.000Z",
            kind="trace.completed",
            parent_id=root["id"],
        )
        with pytest.raises(
            FlightRecorderCorruptionError,
            match="live trace",
        ):
            recorder.import_(
                {
                    "schema": FLIGHT_EXPORT_SCHEMA,
                    "exportedAt": "2026-01-01T00:00:02.000Z",
                    "events": [terminal],
                }
            )
        assert any(
            event["kind"] == "trace.started"
            for event in recorder.query({"traceId": "live-import"})
        )

    recorder.run_trace({"traceId": "live-import"}, import_terminal)


def test_replace_cannot_move_event_out_of_another_live_trace():
    recorder = in_memory_recorder(retention_events=-1)

    def move_event():
        context = recorder.record(
            {"kind": "context.assembled", "source": "test"}
        )
        moved = ledger_event(
            context["id"],
            "other-trace",
            1,
            "2026-01-01T00:00:01.000Z",
            kind="context.assembled",
        )
        with pytest.raises(
            FlightRecorderCorruptionError,
            match="move event.*live trace",
        ):
            recorder.import_(
                {
                    "schema": FLIGHT_EXPORT_SCHEMA,
                    "exportedAt": "2026-01-01T00:00:02.000Z",
                    "events": [moved],
                },
                replace=True,
            )

    recorder.run_trace({"traceId": "original-live"}, move_event)


def test_explicit_inspection_fails_loud_and_recording_remains_fail_open():
    recorder = in_memory_recorder()
    recorder.record(
        {
            "traceId": "corrupt-trace",
            "kind": "agent.execute.completed",
            "source": "test",
        }
    )
    recorder._ledger._db.execute(
        "UPDATE flight_events SET event_json = ? WHERE trace_id = ?",
        ("not-json", "corrupt-trace"),
    )

    with pytest.raises(FlightRecorderCorruptionError, match="not valid JSON"):
        recorder.query({"traceId": "corrupt-trace"})
    health = recorder.health()
    assert health["errorCount"] == 1
    assert "Corrupt flight event row" in health["lastError"]

    with pytest.raises(FlightRecorderCorruptionError):
        recorder.export()
    with pytest.raises(FlightRecorderCorruptionError):
        recorder.export_trace("corrupt-trace")
    assert recorder.health()["errorCount"] == 3

    def fail_append(_event):
        raise RuntimeError("append path failed")

    mutating = in_memory_recorder()
    mutating._ledger.append = fail_append
    assert mutating.run_trace(
        {"traceId": "fail-open"},
        lambda: "still works",
    ) == "still works"
    assert mutating.health()["errorCount"] >= 1
    assert "append path failed" in mutating.health()["lastError"]

    def fail_clear():
        raise RuntimeError("clear failed")

    mutating._ledger.clear = fail_clear
    with pytest.raises(RuntimeError, match="clear failed"):
        mutating.clear()
    assert "clear failed" in mutating.health()["lastError"]

    def fail_import(_data, *, replace=False):
        raise RuntimeError(f"import failed: {replace}")

    mutating._ledger.import_ = fail_import
    with pytest.raises(RuntimeError, match="import failed"):
        mutating.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-01-01T00:00:00.000Z",
                "events": [],
            }
        )
    assert "import failed" in mutating.health()["lastError"]


def test_filtered_inspection_validates_every_snapshot_row():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    events = recorded_trace(
        "filtered-corruption",
        "filtered-corruption",
        0,
        middle_kinds=("context.assembled",),
    )
    for event in events:
        ledger.append(event)
    ledger._db.execute(
        "UPDATE flight_events SET trace_id = ? WHERE id = ?",
        ("hidden-corrupt-trace", events[1]["id"]),
    )

    with pytest.raises(
        FlightRecorderCorruptionError,
        match="traceId does not match event_json",
    ):
        ledger.query({"traceId": "filtered-corruption"})
    with pytest.raises(
        FlightRecorderCorruptionError,
        match="traceId does not match event_json",
    ):
        ledger.export({"traceId": "filtered-corruption"})


def test_global_query_orders_by_chronology_and_rejects_invalid_order():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    for trace in range(20):
        ledger.append(
            ledger_event(
                f"chronology-{trace}",
                f"trace-{trace}",
                100 if trace == 0 else 1,
                f"2026-01-01T00:00:{trace:02d}.000Z",
            )
        )

    newest = ledger.query({"order": "desc", "limit": 5})
    assert [event["id"] for event in newest] == [
        "chronology-19",
        "chronology-18",
        "chronology-17",
        "chronology-16",
        "chronology-15",
    ]
    assert [event["id"] for event in ledger.query({"limit": 2})] == [
        "chronology-0",
        "chronology-1",
    ]
    with pytest.raises(ValueError, match="order"):
        ledger.query({"order": "sideways"})


def test_timestamp_order_filters_and_prune_use_utc_epoch():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    older_offset = ledger_event(
        "older-offset",
        "offset-trace",
        100,
        "2026-01-01T00:30:00+01:00",
    )
    newer_utc = ledger_event(
        "newer-utc",
        "utc-trace",
        1,
        "2025-12-31T23:45:00Z",
    )
    ledger.append(older_offset)
    ledger.append(newer_utc)

    assert [event["id"] for event in ledger.query()] == [
        "older-offset",
        "newer-utc",
    ]
    assert [event["id"] for event in ledger.query({"order": "desc"})] == [
        "newer-utc",
        "older-offset",
    ]
    assert ledger.query({"since": "2025-12-31T23:40:00Z"}) == [newer_utc]
    assert ledger.query({"until": "2025-12-31T23:40:00Z"}) == [older_offset]
    with pytest.raises(FlightRecorderCorruptionError, match="since"):
        ledger.query({"since": "not-a-timestamp"})

    assert ledger.prune(1) == 1
    assert ledger.query() == [newer_utc]


def test_strict_iso_dates_reject_impossible_calendars_and_invalid_offsets():
    invalid_timestamps = (
        "2026-02-29T00:00:00.000Z",
        "2026-02-30T00:00:00.000Z",
        "2026-04-31T00:00:00.000Z",
        "2026-06-15T24:00:00.000Z",
        "2026-06-15T12:00:00.1234Z",
        "2026-06-15T12:00:00+00:60",
        "2026-06-15T12:00:00+14:01",
        "٢٠٢٦-٠٨-١٢T١٢:٣٤:٥٦.٧٨٩Z",
    )
    for index, timestamp in enumerate(invalid_timestamps):
        ledger = SQLiteFlightLedger(in_memory=True)
        ledger.initialize()
        with pytest.raises(FlightRecorderCorruptionError, match="ISO timestamp"):
            ledger.append(
                ledger_event(
                    f"invalid-date-{index}",
                    "invalid-date-trace",
                    1,
                    timestamp,
                )
            )

    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    with pytest.raises(FlightRecorderCorruptionError, match="ISO timestamp"):
        ledger.import_(
            {
                "schema": FLIGHT_EXPORT_SCHEMA,
                "exportedAt": "2026-02-30T00:00:00.000Z",
                "events": [],
            }
        )
    with pytest.raises(FlightRecorderCorruptionError, match="since"):
        ledger.query({"since": "2026-04-31T00:00:00.000Z"})
    valid = (
        ledger_event(
            "valid-leap-day",
            "valid-date-trace",
            1,
            "2024-02-29T23:59:59.999Z",
        ),
        ledger_event(
            "valid-offset",
            "valid-date-trace",
            2,
            "2026-06-15T12:00:00.123-05:30",
        ),
        ledger_event(
            "valid-maximum-offset",
            "valid-date-trace",
            3,
            "2026-06-15T12:00:00+14:00",
        ),
    )
    for event in valid:
        ledger.append(event)
    assert ledger.count() == 3


def test_fractional_timestamp_precision_is_exact_and_version_independent():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    samples = (
        ("fraction-1", "1970-01-01T00:00:00.1Z", 100),
        ("fraction-2", "1970-01-01T00:00:00.12Z", 120),
        ("fraction-3", "1970-01-01T00:00:00.123Z", 123),
        ("pre-epoch", "1969-12-31T23:59:59.999Z", -1),
    )
    for index, (event_id, timestamp, _expected) in enumerate(samples, start=1):
        ledger.append(
            ledger_event(
                event_id,
                f"fraction-trace-{index}",
                1,
                timestamp,
            )
        )

    stored = dict(
        ledger._db.execute(
            f"""
            SELECT id, timestamp_ms FROM flight_events
            WHERE id IN ({','.join('?' for _ in samples)})
            """,
            [event_id for event_id, _timestamp, _expected in samples],
        ).fetchall()
    )
    assert stored == {
        event_id: expected
        for event_id, _timestamp, expected in samples
    }


def test_pre_timestamp_ms_database_migrates_and_backfills_transactionally(work_dir):
    database = work_dir / "legacy-flight.db"
    legacy_event = ledger_event(
        "legacy-event",
        "legacy-trace",
        1,
        "2026-01-01T00:30:00+01:00",
    )
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE flight_events (
                id TEXT PRIMARY KEY,
                sequence INTEGER NOT NULL,
                trace_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id TEXT,
                workspace_id TEXT,
                provider_id TEXT,
                agent_name TEXT,
                tool_name TEXT,
                event_json TEXT NOT NULL,
                UNIQUE (trace_id, sequence)
            );
            CREATE INDEX idx_flight_events_timestamp
                ON flight_events(timestamp);
            """
        )
        connection.execute(
            """
            INSERT INTO flight_events (
                id, sequence, trace_id, timestamp, kind, source, status,
                session_id, workspace_id, provider_id, agent_name, tool_name,
                event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                legacy_event["id"],
                legacy_event["sequence"],
                legacy_event["traceId"],
                legacy_event["timestamp"],
                legacy_event["kind"],
                legacy_event["source"],
                legacy_event["status"],
                None,
                None,
                None,
                None,
                None,
                json.dumps(legacy_event, separators=(",", ":")),
            ),
        )

    ledger = SQLiteFlightLedger(database_path=database)
    ledger.initialize()
    columns = {
        row[1]: row
        for row in ledger._db.execute("PRAGMA table_info(flight_events)").fetchall()
    }
    assert columns["timestamp_ms"][3] == 1
    assert ledger.query() == [legacy_event]
    stored_ms = ledger._db.execute(
        "SELECT timestamp_ms FROM flight_events WHERE id = ?",
        ("legacy-event",),
    ).fetchone()[0]
    assert stored_ms == 1_767_223_800_000


def test_python_reads_typescript_alter_table_timestamp_layout(work_dir):
    database = work_dir / "typescript-layout.db"
    sample = ledger_event(
        "typescript-layout-event",
        "typescript-layout-trace",
        1,
        "2026-01-01T00:00:00.000Z",
    )
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE flight_events (
                id TEXT PRIMARY KEY,
                sequence INTEGER NOT NULL,
                trace_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                kind TEXT NOT NULL,
                source TEXT NOT NULL,
                status TEXT NOT NULL,
                session_id TEXT,
                workspace_id TEXT,
                provider_id TEXT,
                agent_name TEXT,
                tool_name TEXT,
                event_json TEXT NOT NULL,
                timestamp_ms INTEGER NOT NULL DEFAULT 0,
                UNIQUE (trace_id, sequence)
            );
            """
        )
        connection.execute(
            """
            INSERT INTO flight_events (
                id, sequence, trace_id, timestamp, kind, source, status,
                session_id, workspace_id, provider_id, agent_name, tool_name,
                event_json, timestamp_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sample["id"],
                sample["sequence"],
                sample["traceId"],
                sample["timestamp"],
                sample["kind"],
                sample["source"],
                sample["status"],
                None,
                None,
                None,
                None,
                None,
                json.dumps(sample, separators=(",", ":")),
                1_767_225_600_000,
            ),
        )

    ledger = SQLiteFlightLedger(database_path=database)
    ledger.initialize()
    assert ledger.query() == [sample]


def test_retention_keeps_an_oversized_completed_trace_whole():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    completed = recorded_trace(
        "oversized-completed-trace",
        "oversized",
        0,
        middle_kinds=(
            "context.assembled",
            "provider.attempt.completed",
            "agent.execute.completed",
        ),
    )
    for event in completed:
        ledger.append(event)

    assert ledger.prune(3) == 0
    assert ledger.query({"traceId": "oversized-completed-trace"}) == completed


def test_retention_prunes_an_older_completed_trace_as_a_whole():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    older = recorded_trace(
        "older-completed-trace",
        "older",
        0,
        middle_kinds=("context.assembled",),
    )
    newer = recorded_trace(
        "newer-completed-trace",
        "newer",
        10,
        middle_kinds=("context.assembled",),
    )
    for event in [*older, *newer]:
        ledger.append(event)

    assert ledger.prune(len(newer)) == len(older)
    assert ledger.query() == newer
    assert ledger.query({"traceId": "older-completed-trace"}) == []


def test_retention_always_preserves_active_traces():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    completed = recorded_trace(
        "old-completed-trace",
        "old-completed",
        0,
        middle_kinds=("context.assembled",),
    )
    active = recorded_trace(
        "active-trace",
        "active",
        10,
        middle_kinds=("context.assembled", "provider.attempt.started"),
        terminal=None,
    )
    for event in [*completed, *active]:
        ledger.append(event)

    assert ledger.prune(1) == 0
    assert ledger.query({"traceId": "active-trace"}) == active
    assert ledger.query({"traceId": "old-completed-trace"}) == completed
    assert ledger.count() == len(active) + len(completed)


def test_retention_preserves_newest_completed_trace_alongside_active():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    active = recorded_trace(
        "active-pinned",
        "active-pinned",
        0,
        middle_kinds=("context.assembled",),
        terminal=None,
    )
    completed = recorded_trace(
        "completed-pinned",
        "completed-pinned",
        10,
    )
    for event in [*active, *completed]:
        ledger.append(event)

    assert ledger.prune(3) == 0
    assert ledger.query({"traceId": "active-pinned"}) == active
    assert ledger.query({"traceId": "completed-pinned"}) == completed


def test_retention_treats_a_restarted_completed_trace_as_active():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    old_completed = recorded_trace(
        "old-completed-trace",
        "old-completed",
        0,
    )
    resumed = [
        ledger_event(
            "resumed-start-1",
            "resumed-trace",
            1,
            "2026-01-01T00:00:10.000Z",
            kind="trace.started",
        ),
        ledger_event(
            "resumed-complete",
            "resumed-trace",
            2,
            "2026-01-01T00:00:11.000Z",
            kind="trace.completed",
            parent_id="resumed-start-1",
        ),
        ledger_event(
            "resumed-start-2",
            "resumed-trace",
            3,
            "2026-01-01T00:00:12.000Z",
            kind="trace.started",
        ),
        ledger_event(
            "resumed-context",
            "resumed-trace",
            4,
            "2026-01-01T00:00:13.000Z",
            kind="context.assembled",
            parent_id="resumed-start-2",
        ),
    ]
    for event in [*old_completed, *resumed]:
        ledger.append(event)

    assert ledger.prune(1) == 0
    assert ledger.query({"traceId": "resumed-trace"}) == resumed
    assert ledger.query({"traceId": "old-completed-trace"}) == old_completed


def test_retention_uses_sequence_depth_for_nested_and_clock_rollback_traces():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    completed = recorded_trace(
        "completed-before-nested",
        "completed-before-nested",
        0,
    )
    nested_active = [
        ledger_event(
            "nested-outer-start",
            "nested-active",
            1,
            "2026-06-01T00:00:00.000Z",
            kind="trace.started",
        ),
        ledger_event(
            "nested-inner-start",
            "nested-active",
            2,
            "2026-06-01T00:00:01.000Z",
            kind="trace.started",
        ),
        ledger_event(
            "nested-inner-complete",
            "nested-active",
            3,
            "2026-06-01T00:00:02.000Z",
            kind="trace.completed",
        ),
    ]
    rollback_active = [
        ledger_event(
            "rollback-start-1",
            "rollback-active",
            1,
            "2026-05-01T00:00:00.000Z",
            kind="trace.started",
        ),
        ledger_event(
            "rollback-complete",
            "rollback-active",
            2,
            "2026-05-01T00:00:01.000Z",
            kind="trace.completed",
        ),
        ledger_event(
            "rollback-start-2",
            "rollback-active",
            3,
            "2025-01-01T00:00:00.000Z",
            kind="trace.started",
        ),
    ]
    for event in [*completed, *nested_active, *rollback_active]:
        ledger.append(event)

    assert ledger.prune(0) == len(completed)
    assert ledger.query({"traceId": "nested-active"}) == nested_active
    assert ledger.query({"traceId": "rollback-active"}) == rollback_active


def test_ledger_refuses_clear_while_trace_is_active():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    ledger.append(
        ledger_event(
            "active-clear-start",
            "active-clear",
            1,
            "2026-01-01T00:00:00.000Z",
            kind="trace.started",
        )
    )
    with pytest.raises(Exception, match="active traces"):
        ledger.clear()
    assert ledger.count() == 1
    ledger.append(
        ledger_event(
            "active-clear-complete",
            "active-clear",
            2,
            "2026-01-01T00:00:01.000Z",
            kind="trace.completed",
            parent_id="active-clear-start",
        )
    )
    ledger.clear()
    assert ledger.count() == 0


def test_orphaned_trace_from_dead_process_is_prunable():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    ledger.append(
        ledger_event(
            "orphaned-start",
            "orphaned-trace",
            1,
            "2026-01-01T00:00:00.000Z",
            kind="trace.started",
            metadata={"ownerPid": 2_147_483_647},
        )
    )

    assert ledger.prune(0) == 1
    assert ledger.count() == 0


def test_reused_pid_with_different_incarnation_is_not_active():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    ledger.append(
        ledger_event(
            "reused-pid-start",
            "reused-pid",
            1,
            "2026-01-01T00:00:00.000Z",
            kind="trace.started",
            metadata={
                "ownerPid": os.getpid(),
                "ownerIncarnation": "different-process-start",
            },
        )
    )

    assert ledger.prune(0) == 1


def test_lifecycle_terminal_matches_exact_parent_start():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    live_start = ledger_event(
        "live-start",
        "parent-match",
        1,
        "2026-01-01T00:00:00.000Z",
        kind="trace.started",
        metadata={"ownerPid": os.getpid()},
    )
    dead_start = ledger_event(
        "dead-start",
        "parent-match",
        2,
        "2026-01-01T00:00:01.000Z",
        kind="trace.started",
        metadata={"ownerPid": 2_147_483_647},
    )
    live_complete = ledger_event(
        "live-complete",
        "parent-match",
        3,
        "2026-01-01T00:00:02.000Z",
        kind="trace.completed",
        parent_id=live_start["id"],
    )
    for event in (live_start, dead_start, live_complete):
        ledger.append(event)

    assert ledger.prune(0) == 3
    assert ledger.count() == 0


def test_retention_preserves_completed_trace_when_atomic_events_fill_target():
    ledger = SQLiteFlightLedger(in_memory=True)
    ledger.initialize()
    completed = recorded_trace(
        "completed-trace",
        "completed",
        0,
        middle_kinds=("context.assembled", "agent.execute.completed"),
    )
    atomic = [
        ledger_event(
            f"atomic-{index}",
            "atomic-trace",
            index,
            f"2026-01-01T00:00:{9 + index:02d}.000Z",
        )
        for index in range(1, 4)
    ]
    for event in [*completed, *atomic]:
        ledger.append(event)

    assert ledger.prune(5) == len(atomic)
    assert ledger.query({"traceId": "completed-trace"}) == completed
    assert ledger.query({"traceId": "atomic-trace"}) == []


def test_concurrent_traces_are_isolated_and_ordered():
    recorder = in_memory_recorder()

    def run(index):
        trace_id = f"concurrent-{index}"
        recorder.run_trace(
            {"traceId": trace_id, "sessionId": f"session-{index}"},
            lambda: recorder.record(
                {
                    "kind": "agent.execute.completed",
                    "source": "test",
                    "agentName": f"Agent{index}",
                }
            ),
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(run, range(20)))

    for index in range(20):
        events = recorder.export_trace(f"concurrent-{index}")["events"]
        assert [event["sequence"] for event in events] == [1, 2, 3]
        assert {event["traceId"] for event in events} == {f"concurrent-{index}"}
        assert {event["sessionId"] for event in events} == {
            normalize_flight_session_id(
                f"session-{index}",
                TEST_IDENTITY_KEY,
            )
        }


def test_shared_recorders_enforce_retention_from_authoritative_count(work_dir):
    database = work_dir / "shared-retention" / "flight.db"
    database.parent.mkdir()
    first = FlightRecorder(
        enabled=True,
        database_path=database,
        retention_events=10,
    )
    second = FlightRecorder(
        enabled=True,
        database_path=database,
        retention_events=10,
    )
    first.initialize()
    second.initialize()
    try:
        for index in range(6):
            first.record(
                {
                    "traceId": f"shared-first-{index}",
                    "kind": "atomic",
                    "source": "test",
                }
            )
            second.record(
                {
                    "traceId": f"shared-second-{index}",
                    "kind": "atomic",
                    "source": "test",
                }
            )
        assert first.count() == 10
    finally:
        first.close()
        second.close()


def test_many_shared_recorders_eventually_allocate_every_same_trace_sequence(
    work_dir,
):
    database = work_dir / "shared-sequence" / "flight.db"
    database.parent.mkdir()
    recorders = [
        FlightRecorder(
            enabled=True,
            database_path=database,
            retention_events=-1,
        )
        for _ in range(12)
    ]
    for recorder in recorders:
        recorder.initialize()
    try:
        with ThreadPoolExecutor(max_workers=12) as pool:
            events = list(
                pool.map(
                    lambda recorder: recorder.record(
                        {
                            "traceId": "shared-concurrent-trace",
                            "kind": "atomic",
                            "source": "test",
                        }
                    ),
                    recorders,
                )
            )
        assert all(event is not None for event in events)
        assert sorted(event["sequence"] for event in events) == list(
            range(1, 13)
        )
    finally:
        for recorder in recorders:
            recorder.close()


def test_completed_trace_sequence_and_lock_state_are_evicted():
    recorder = in_memory_recorder()
    for index in range(250):
        recorder.run_trace({"traceId": f"bounded-{index}"}, lambda: None)

    assert recorder._sequence_by_trace == {}
    assert recorder._sequence_in_flight == set()
    assert recorder._initialization_waiters == 0
    assert recorder._initializing is False

    recorder.run_trace({"traceId": "bounded-0"}, lambda: None)
    assert [
        event["sequence"]
        for event in recorder.export_trace("bounded-0")["events"]
    ] == [1, 2, 3, 4]
    assert recorder._sequence_by_trace == {}
    assert recorder._sequence_in_flight == set()


def test_standalone_direct_records_evict_sequence_cache():
    recorder = in_memory_recorder(retention_events=0)
    for index in range(1_000):
        recorder.record(
            {
                "traceId": f"standalone-{index}",
                "kind": "atomic",
                "source": "test",
            }
        )

    assert recorder._sequence_by_trace == {}
    assert recorder._sequence_in_flight == set()
    assert recorder.count() == 0


def test_close_waits_for_in_progress_clear():
    class SlowClearLedger(SQLiteFlightLedger):
        def __init__(self):
            super().__init__(in_memory=True)
            self.entered = threading.Event()
            self.release = threading.Event()

        def clear(self):
            self.entered.set()
            self.release.wait(timeout=5)
            return super().clear()

    ledger = SlowClearLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        ledger=ledger,
    )
    recorder.initialize()
    with ThreadPoolExecutor(max_workers=2) as pool:
        clearing = pool.submit(recorder.clear)
        assert ledger.entered.wait(timeout=5)
        closing = pool.submit(recorder.close)
        time.sleep(0.02)
        assert not closing.done()
        ledger.release.set()
        assert clearing.result(timeout=5) is True
        closing.result(timeout=5)
    assert recorder.health()["initialized"] is False


def test_runtime_owner_metadata_bypasses_user_redaction_only_for_trace_start():
    recorder = in_memory_recorder(
        retention_events=0,
        privacy={"redactedKeys": ["ownerPid"]},
    )

    def inspect_active():
        assert any(
            event["kind"] == "trace.started"
            for event in recorder.query({"traceId": "reserved-owner"})
        )

    recorder.run_trace({"traceId": "reserved-owner"}, inspect_active)
    ordinary = recorder.record(
        {
            "traceId": "user-owner-metadata",
            "kind": "ordinary",
            "source": "test",
            "metadata": {
                "ownerId": "forged",
                "ownerPid": os.getpid(),
            },
        }
    )
    assert ordinary["metadata"] == {}


def test_session_pseudonyms_are_keyed():
    handle = "+15551234567"
    first = normalize_flight_session_id(handle, TEST_IDENTITY_KEY)
    second = normalize_flight_session_id(handle, "44" * 32)
    assert re.fullmatch(r"session:[0-9a-f]{24}", first)
    assert first == "session:e523e4096e6419b507b73af3"
    assert first != second


def test_top_level_identifiers_are_sanitized_during_recording():
    recorder = in_memory_recorder()
    token = f"ghp_{'x' * 32}"
    event = recorder.record(
        {
            "traceId": token,
            "kind": "ordinary",
            "source": "/Users/alice/.ssh/id_ed25519",
            "providerId": token,
        }
    )

    serialized = json.dumps(event)
    assert token not in serialized
    assert "id_ed25519" not in serialized
    assert event["traceId"].startswith("trace:")
    workspace_event = recorder.record(
        {
            "traceId": "workspace-secret",
            "kind": "ordinary",
            "source": "test",
            "workspaceId": token,
        }
    )
    assert workspace_event["workspaceId"].startswith("workspace:")


class SlowCountingLedger(SQLiteFlightLedger):
    def __init__(self):
        super().__init__(in_memory=True)
        self.initialize_calls = 0
        self._counter_lock = threading.Lock()

    def initialize(self):
        with self._counter_lock:
            self.initialize_calls += 1
        time.sleep(0.03)
        super().initialize()


class RetentionCountingLedger(SQLiteFlightLedger):
    def __init__(self):
        super().__init__(in_memory=True)
        self.prune_calls = 0

    def prune(self, keep):
        self.prune_calls += 1
        return super().prune(keep)


class FailOnceAppendLedger(SQLiteFlightLedger):
    def __init__(self):
        super().__init__(in_memory=True)
        self.failed = False

    def append(self, event):
        if not self.failed:
            self.failed = True
            raise RuntimeError("append failed once")
        return super().append(event)


class PruneFailingLedger(SQLiteFlightLedger):
    def prune(self, _keep):
        raise RuntimeError("prune failed")


def test_append_and_retention_failures_preserve_sequence_and_durable_event_ids():
    append_ledger = FailOnceAppendLedger()
    append_recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        retention_events=-1,
        ledger=append_ledger,
    )
    append_recorder.initialize()
    assert append_recorder.record(
        {"traceId": "append-retry", "kind": "first", "source": "test"}
    ) is None
    persisted = append_recorder.record(
        {"traceId": "append-retry", "kind": "second", "source": "test"}
    )
    assert persisted["sequence"] == 1

    prune_ledger = PruneFailingLedger(in_memory=True)
    prune_recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        retention_events=0,
        ledger=prune_ledger,
    )
    prune_recorder.initialize()
    first = prune_recorder.record(
        {"traceId": "prune-health", "kind": "first", "source": "test"}
    )
    second = prune_recorder.record(
        {"traceId": "prune-health", "kind": "second", "source": "test"}
    )
    assert [first["sequence"], second["sequence"]] == [1, 2]
    assert [event["id"] for event in prune_ledger.query()] == [
        first["id"],
        second["id"],
    ]
    assert prune_recorder.health()["errorCount"] == 2
    assert "prune failed" in prune_recorder.health()["lastError"]


def test_long_trace_sequence_recovery_uses_one_descending_query():
    class LongTraceLedger:
        def __init__(self):
            self.queries = []
            self.events = []

        def initialize(self):
            pass

        def close(self):
            pass

        def count(self):
            return len(self.events)

        def query(self, query):
            self.queries.append(query)
            return [{"sequence": 1_010_000}]

        def append(self, event):
            self.events.append(event)

        def prune(self, _keep):
            return 0

    ledger = LongTraceLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        retention_events=-1,
        ledger=ledger,
    )
    recorder.initialize()
    persisted = recorder.record(
        {
            "traceId": "million-event-trace",
            "kind": "continued",
            "source": "test",
        }
    )

    assert persisted["sequence"] == 1_010_001
    assert ledger.queries == [
        {
            "traceId": "million-event-trace",
            "order": "desc",
            "limit": 1,
        }
    ]


def test_retention_maintenance_is_batched_above_the_target():
    ledger = RetentionCountingLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        retention_events=101,
        ledger=ledger,
    )
    recorder.initialize()

    for index in range(112):
        recorder.record(
            {
                "traceId": f"retention-batch-{index}",
                "kind": "agent.execute.completed",
                "source": "test",
            }
        )

    assert ledger.prune_calls == 1
    assert recorder.count() == 100


def test_clear_blocks_direct_records_until_deletion_finishes():
    class SlowClearLedger(SQLiteFlightLedger):
        def __init__(self):
            super().__init__(in_memory=True)
            self.entered = threading.Event()
            self.release = threading.Event()

        def clear(self):
            self.entered.set()
            self.release.wait(timeout=5)
            return super().clear()

    ledger = SlowClearLedger()
    recorder = FlightRecorder(
        enabled=True,
        in_memory=True,
        identity_key=TEST_IDENTITY_KEY,
        retention_events=-1,
        ledger=ledger,
    )
    recorder.initialize()
    recorder.record(
        {"traceId": "before-clear", "kind": "before", "source": "test"}
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        clearing = pool.submit(recorder.clear)
        assert ledger.entered.wait(timeout=5)
        second_clear = pool.submit(recorder.clear)
        assert recorder.record(
            {
                "traceId": "during-clear",
                "kind": "during",
                "source": "test",
            }
        ) is None
        ledger.release.set()
        assert clearing.result(timeout=5) is True
        assert second_clear.result(timeout=5) is True
    assert recorder.count() == 0


def test_windows_invalid_pid_error_is_classified_as_dead(monkeypatch):
    error = OSError("invalid process")
    error.winerror = 87

    def invalid_pid(_pid, _signal):
        raise error

    monkeypatch.setattr(os, "kill", invalid_pid)
    assert _process_is_alive(999999) is False


def test_process_incarnation_refreshes_after_fork(monkeypatch):
    import openrappter.flight_recorder as module

    child_pid = os.getpid() + 10_000
    monkeypatch.setattr(module.os, "getpid", lambda: child_pid)
    monkeypatch.setattr(
        module,
        "_read_process_incarnation",
        lambda pid: f"child:{pid}",
    )

    assert _current_process_incarnation() == f"child:{child_pid}"


def test_after_fork_reset_does_not_unlink_parent_owner(work_dir):
    database = work_dir / "fork-owner" / "flight.db"
    database.parent.mkdir()
    recorder = FlightRecorder(enabled=True, database_path=database)
    recorder.initialize()
    owner_path = recorder._owner_path
    assert owner_path is not None and owner_path.exists()

    _reset_flight_recorder_after_fork()

    assert owner_path.exists()
    assert recorder._owner_path is None
    assert recorder.health()["initialized"] is False
    owner_path.unlink(missing_ok=True)


def test_after_fork_reset_recreates_global_lock():
    import openrappter.flight_recorder as module

    previous_lock = module._global_lock
    _reset_flight_recorder_after_fork()

    assert module._global_lock is not previous_lock


def test_barrier_disappearance_during_revalidation_is_reclaimed():
    class DisappearingBarrier:
        def __init__(self):
            self.stat_calls = 0

        def stat(self):
            self.stat_calls += 1
            if self.stat_calls == 1:
                return type(
                    "Stat",
                    (),
                    {
                        "st_dev": 1,
                        "st_ino": 1,
                        "st_mtime_ns": 1,
                        "st_size": 1,
                    },
                )()
            raise FileNotFoundError

        def read_text(self, **_kwargs):
            return "2147483647"

    assert _reset_barrier_is_active(DisappearingBarrier()) is False


def test_concurrent_cold_start_initializes_once_and_reset_clears_state():
    ledger = SlowCountingLedger()
    recorder = FlightRecorder(enabled=True, in_memory=True, ledger=ledger)

    with ThreadPoolExecutor(max_workers=12) as pool:
        list(
            pool.map(
                lambda index: recorder.run_trace(
                    {"traceId": f"cold-{index}"}, lambda: None
                ),
                range(12),
            )
        )

    assert ledger.initialize_calls == 1
    assert recorder.count() == 24
    assert recorder.health()["initialized"] is True
    assert recorder._initializing is False
    assert recorder._initialization_waiters == 0
    assert recorder._sequence_by_trace == {}
    assert recorder._sequence_in_flight == set()

    set_flight_recorder(recorder)
    reset_flight_recorder_environment_for_tests()
    assert recorder.health()["initialized"] is False
    assert recorder._initializing is False
    assert recorder._closing is False
    assert recorder._initialization_waiters == 0
    assert recorder._sequence_by_trace == {}
    assert recorder._sequence_in_flight == set()
    assert get_flight_recorder().health()["enabled"] is False


class FailingLedger:
    def __init__(self, failure):
        self.failure = failure
        self.initialized = False

    def initialize(self):
        if self.failure == "initialize":
            raise RuntimeError("initialize failed")
        self.initialized = True

    def close(self):
        pass

    def append(self, _event):
        if self.failure == "append":
            raise RuntimeError("append failed")

    def query(self, *_args, **_kwargs):
        return []

    def count(self):
        return 0

    def prune(self, _keep):
        return 0


def test_disabled_noop_and_fail_open_health():
    disabled_ledger = FailingLedger("initialize")
    disabled = FlightRecorder(enabled=False, ledger=disabled_ledger)
    assert disabled.run_trace({}, lambda: 42) == 42
    assert disabled.record({"kind": "ignored", "source": "test"}) is None
    assert disabled.health() == {
        "enabled": False,
        "initialized": False,
        "eventCount": 0,
        "errorCount": 0,
        "databasePath": str(Path.home() / ".openrappter" / "flight-recorder.db"),
    }
    with pytest.raises(FlightRecorderUnhealthyError, match="disabled"):
        disabled.query()
    with pytest.raises(FlightRecorderUnhealthyError, match="disabled"):
        disabled.export()
    with pytest.raises(FlightRecorderUnhealthyError, match="disabled"):
        disabled.clear()

    failing = FlightRecorder(enabled=True, ledger=FailingLedger("append"))
    assert failing.run_trace({}, lambda: "still works") == "still works"
    health = failing.health()
    assert health["initialized"] is True
    assert health["errorCount"] >= 1
    assert "append failed" in health["lastError"]


def test_initialization_failure_uses_retry_cooldown():
    class CountingFailureLedger(FailingLedger):
        def __init__(self):
            super().__init__("initialize")
            self.initialize_calls = 0

        def initialize(self):
            self.initialize_calls += 1
            return super().initialize()

    ledger = CountingFailureLedger()
    recorder = FlightRecorder(enabled=True, ledger=ledger)
    assert recorder.run_trace({}, lambda: "still works") == "still works"
    assert ledger.initialize_calls == 1


def test_concurrent_initialization_failures_share_one_cooldown_attempt():
    class SlowFailureLedger(FailingLedger):
        def __init__(self):
            super().__init__("initialize")
            self.initialize_calls = 0

        def initialize(self):
            self.initialize_calls += 1
            time.sleep(0.05)
            return super().initialize()

    ledger = SlowFailureLedger()
    recorder = FlightRecorder(enabled=True, ledger=ledger)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(
            pool.map(
                lambda index: recorder.record(
                    {
                        "traceId": f"failed-init-{index}",
                        "kind": "event",
                        "source": "test",
                    }
                ),
                range(8),
            )
        )

    assert ledger.initialize_calls == 1


def test_failed_initialization_is_fail_open_for_recording_but_unhealthy_for_inspection():
    recorder = FlightRecorder(enabled=True, ledger=FailingLedger("initialize"))
    assert recorder.record({"kind": "ignored", "source": "test"}) is None
    health = recorder.health()
    assert health["initialized"] is False
    assert "initialize failed" in health["lastError"]

    with pytest.raises(FlightRecorderUnhealthyError, match="initialize failed"):
        recorder.query()
    with pytest.raises(FlightRecorderUnhealthyError, match="initialize failed"):
        recorder.export()
    with pytest.raises(FlightRecorderUnhealthyError, match="initialize failed"):
        recorder.clear()


class RecordingAgent(BasicAgent):
    def __init__(self, outcome=None, error=None):
        super().__init__(
            "RecordingAgent",
            {
                "name": "RecordingAgent",
                "description": "test",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        )
        self.outcome = outcome
        self.error = error

    def perform(self, **kwargs):
        if self.error:
            raise self.error
        return self.outcome


def test_basic_agent_records_context_and_preserves_return_and_error_semantics():
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    outcome = '{"status":"success"}'
    assert RecordingAgent(outcome=outcome).execute(query="hello") is outcome
    kinds = [event["kind"] for event in recorder.query({"agentName": "RecordingAgent"})]
    assert kinds == [
        "agent.execute.started",
        "context.assembled",
        "agent.execute.completed",
    ]
    agent_events = recorder.query({"agentName": "RecordingAgent"})
    assert agent_events[1]["parentId"] == agent_events[0]["id"]
    assert agent_events[2]["parentId"] == agent_events[0]["id"]

    original = ValueError("original failure")
    with pytest.raises(ValueError) as caught:
        RecordingAgent(error=original).execute(query="fail")
    assert caught.value is original
    failed_agent = recorder.query({"kind": "agent.execute.failed"})[-1]
    assert failed_agent["status"] == "error"
    assert failed_agent["metadata"]["messageChars"] == len(str(original))
    assert "original failure" not in json.dumps(failed_agent)

    error_result = '{"status":"error","message":"command failed"}'
    assert RecordingAgent(outcome=error_result).execute(query="error") == error_result
    error_event = recorder.query({"kind": "agent.execute.failed"})[-1]
    assert error_event["status"] == "error"
    assert error_event["metadata"]["resultStatus"] == "error"

    uppercase_error = '{"status":"ERROR","message":"command failed"}'
    assert (
        RecordingAgent(outcome=uppercase_error).execute(query="error")
        == uppercase_error
    )
    uppercase_event = recorder.query(
        {"kind": "agent.execute.failed"}
    )[-1]
    assert uppercase_event["metadata"]["resultStatus"] == "error"

    io_recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(io_recorder)
    RecordingAgent(
        outcome='{"status":"success","password":"secret-value"}'
    ).execute(query="success")
    completed = io_recorder.query(
        {"kind": "agent.execute.completed"}
    )[0]
    assert completed["payload"]["result"]["password"] == "[redacted]"


def test_python_basic_agent_context_is_invocation_local():
    barrier = threading.Barrier(2)

    class ConcurrentAgent(BasicAgent):
        def __init__(self):
            super().__init__(
                "ConcurrentAgent",
                {
                    "name": "ConcurrentAgent",
                    "description": "context isolation",
                    "parameters": {
                        "type": "object",
                        "properties": {},
                        "required": [],
                    },
                },
            )

        def perform(self, **kwargs):
            captured = self.context
            expected_guid = kwargs.get("user_guid")
            barrier.wait(timeout=2)
            return json.dumps(
                {
                    "query": kwargs.get("query"),
                    "sameContext": captured is self.context,
                    "sameGuid": self._user_guid == expected_guid,
                }
            )

    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    agent = ConcurrentAgent()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda item: json.loads(
                    agent.execute(
                        query=item,
                        user_guid=f"guid-{item}",
                    )
                ),
                ("alpha", "beta"),
            )
        )

    assert {result["query"] for result in results} == {"alpha", "beta"}
    assert all(result["sameContext"] for result in results)
    assert all(result["sameGuid"] for result in results)


class InMemoryChannel(BaseChannel):
    def __init__(self):
        super().__init__("memory", channel_type="mock")
        self.sent = []

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.connected = False

    def send(self, _conversation_id, message: OutgoingMessage):
        self.sent.append(message)


class FakeProvider:
    def __init__(self, response=None, error=None):
        self.name = "fake-provider"
        self.model = "configured-model"
        self.response = response
        self.error = error
        self.received_options = None

    def chat(self, _messages, _options=None):
        self.received_options = _options
        if self.error:
            raise self.error
        return self.response


def test_provider_bridge_records_success_and_failure_without_io():
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    channel = InMemoryChannel()
    success = ProviderChannelBridge(
        channel,
        FakeProvider(ProviderResponse(content="ok", model="actual-model")),
    )
    success._on_incoming(
        IncomingMessage(channel_id="memory", conversation_id="c1", content="secret prompt")
    )
    completed = recorder.query({"kind": "provider.attempt.completed"})[0]
    started = recorder.query({"kind": "provider.attempt.started"})[0]
    assert completed["providerId"] == "fake-provider"
    assert completed["model"] == "actual-model"
    assert completed["parentId"] == started["id"]
    assert completed["sessionId"] == normalize_flight_session_id(
        "c1",
        TEST_IDENTITY_KEY,
    )
    assert completed["workspaceId"] == "channel:memory"
    assert "payload" not in completed

    provider_token = f"ghp_{'p' * 32}"
    provider_bearer = "Bearer header.payload.signature"
    provider_body = "raw provider response body"
    provider_message = (
        f"HTTP 401 {provider_bearer} token={provider_token} body={provider_body}"
    )
    failure = ProviderChannelBridge(
        channel,
        FakeProvider(error=ProviderError(provider_message)),
    )
    with pytest.raises(ChannelDispatchError) as caught:
        failure._on_incoming(
            IncomingMessage(channel_id="memory", conversation_id="c2", content="other prompt")
        )
    assert str(caught.value) == provider_message
    failed = recorder.query({"kind": "provider.attempt.failed"})[0]
    failed_trace = recorder.query({"traceId": failed["traceId"]})
    failed_started = next(
        event for event in failed_trace if event["kind"] == "provider.attempt.started"
    )
    assert failed["parentId"] == failed_started["id"]
    assert failed["metadata"]["errorName"] == "ProviderError"
    assert failed["metadata"]["messageChars"] == len(provider_message)
    assert failed["metadata"]["messageHash"] == hashlib.sha256(
        provider_message.encode("utf-8")
    ).hexdigest()
    assert "payload" not in failed
    assert failed["sessionId"] == normalize_flight_session_id(
        "c2",
        TEST_IDENTITY_KEY,
    )
    assert failed["workspaceId"] == "channel:memory"
    exported = json.dumps(recorder.export())
    assert "secret prompt" not in exported
    assert provider_token not in exported
    assert provider_bearer not in exported
    assert provider_body not in exported
    assert provider_message not in exported

    unknown_failure = ProviderChannelBridge(
        channel,
        FakeProvider(error=RuntimeError("unexpected provider failure")),
    )
    with pytest.raises(RuntimeError, match="unexpected provider failure"):
        unknown_failure._on_incoming(
            IncomingMessage(
                channel_id="memory",
                conversation_id="c3",
                content="third prompt",
            )
        )
    runtime_failed = recorder.query({"kind": "provider.attempt.failed"})[-1]
    assert runtime_failed["metadata"]["errorName"] == "RuntimeError"

    unknown_model = ProviderChannelBridge(
        channel,
        FakeProvider(ProviderResponse(content="ok", model="")),
        chat_options=ChatOptions(model="requested-only"),
    )
    unknown_model._on_incoming(
        IncomingMessage(
            channel_id="memory",
            conversation_id="c4",
            content="fourth prompt",
        )
    )
    unattributed = recorder.query({"kind": "provider.attempt.completed"})[-1]
    assert "model" not in unattributed
    assert unattributed["metadata"]["modelPolicy"] == "requested-only"


def test_auto_model_policy_reaches_provider_but_is_not_persisted_as_model():
    assert normalize_flight_model_id(" AUTO ") is None
    assert normalize_flight_model_id(" gpt-4.1 ") == "gpt-4.1"
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    channel = InMemoryChannel()
    provider = FakeProvider(ProviderResponse(content="ok", model="resolved-model"))
    bridge = ProviderChannelBridge(
        channel,
        provider,
        chat_options=ChatOptions(model="auto"),
    )

    bridge._on_incoming(
        IncomingMessage(channel_id="memory", conversation_id="auto-model", content="hi")
    )

    assert provider.received_options.model == "auto"
    provider_events = recorder.query({"providerId": "fake-provider"})
    assert [event["kind"] for event in provider_events] == [
        "provider.attempt.started",
        "provider.attempt.completed",
    ]
    assert "model" not in provider_events[0]
    assert provider_events[1]["model"] == "resolved-model"
    assert provider_events[1]["parentId"] == provider_events[0]["id"]
    assert all(event["metadata"]["modelPolicy"] == "auto" for event in provider_events)


def test_provider_bridge_records_structured_io_when_opted_in():
    recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(recorder)
    channel = InMemoryChannel()
    bridge = ProviderChannelBridge(
        channel,
        FakeProvider(
            ProviderResponse(
                content='{"password":"ordinary-secret-value"}',
                model="actual",
            )
        ),
    )

    bridge._on_incoming(
        IncomingMessage(
            channel_id="memory",
            conversation_id="io",
            content='{"password":"incoming-secret"}',
        )
    )

    started = recorder.query({"kind": "provider.attempt.started"})[0]
    completed = recorder.query({"kind": "provider.attempt.completed"})[0]
    assert started["payload"]["messages"][-1]["content"] == {
        "password": "[redacted]"
    }
    assert completed["payload"]["response"]["content"]["password"] == (
        "[redacted]"
    )


class FakeRegistry:
    def get_all_agents(self):
        return {}

    def get_agent_metadata_tools(self):
        return []

    def list_agents(self):
        return []


class ToolRegistry:
    def __init__(self):
        self.agent = RecordingAgent(outcome='{"status":"success","value":7}')

    def get_all_agents(self):
        return {"RecordingAgent": self.agent}

    def get_agent_metadata_tools(self):
        return [
            {
                "type": "function",
                "function": self.agent.metadata,
            }
        ]

    def list_agents(self):
        return [
            {
                "name": "RecordingAgent",
                "description": "deterministic test agent",
            }
        ]


class FakeCopilot:
    id = "fake-copilot"
    model = "gpt-test"

    def __init__(self, response):
        self.response = response

    def chat(self, **_kwargs):
        return self.response


@pytest.mark.parametrize(
    ("response", "terminal_kind"),
    [
        ({"content": "hello", "tool_calls": None, "error": None}, "provider.attempt.completed"),
        ({"content": None, "tool_calls": None, "error": "offline"}, "provider.attempt.failed"),
    ],
)
def test_cli_assistant_provider_success_and_failure(response, terminal_kind):
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    assistant = Assistant(FakeRegistry())
    assistant.copilot = FakeCopilot(response)
    result = assistant.process_message("private input")
    assert isinstance(result, str)
    terminal = recorder.query({"kind": terminal_kind})[0]
    provider_events = recorder.query({"traceId": terminal["traceId"]})
    started = next(
        event for event in provider_events if event["kind"] == "provider.attempt.started"
    )
    assert terminal["providerId"] == "fake-copilot"
    assert "model" not in terminal
    assert terminal["metadata"]["modelPolicy"] == "gpt-test"
    assert started["parentId"] == provider_events[0]["id"]
    assert terminal["parentId"] == started["id"]
    assert terminal["sessionId"] == normalize_flight_session_id(
        "python-cli",
        TEST_IDENTITY_KEY,
    )
    assert terminal["workspaceId"] == normalize_flight_workspace_id(str(Path.cwd()))
    assert str(Path.cwd()) not in json.dumps(recorder.export())
    assert "payload" not in terminal
    assert "private input" not in json.dumps(recorder.export())
    if response.get("error"):
        assert response["error"] not in json.dumps(recorder.export())


def test_python_cli_provider_only_turn_records_replay_io():
    recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(recorder)
    assistant = Assistant(FakeRegistry())
    assistant.copilot = FakeCopilot({
        "content": '{"password":"response-secret","answer":"ok"}',
        "tool_calls": None,
        "error": None,
        "model": "resolved-model",
    })

    assistant.process_message(
        '{"password":"prompt-secret","request":"hello"}'
    )

    context = recorder.query({"kind": "context.assembled"})[0]
    started = recorder.query({"kind": "provider.attempt.started"})[0]
    completed = recorder.query({"kind": "provider.attempt.completed"})[0]
    assert context["payload"]["messages"][-1]["content"]["password"] == (
        "[redacted]"
    )
    assert started["payload"]["messages"] == context["payload"]["messages"]
    assert completed["payload"]["response"]["content"]["password"] == (
        "[redacted]"
    )
    exported = json.dumps(recorder.export())
    assert "prompt-secret" not in exported
    assert "response-secret" not in exported


def test_python_cli_tool_and_agent_events_have_causal_parents():
    recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(recorder)
    assistant = Assistant(ToolRegistry())
    assistant.copilot = FakeCopilot({
        "content": None,
        "error": None,
        "model": "resolved-model",
        "tool_calls": [
            {
                "name": "RecordingAgent",
                "arguments": (
                    '{"query":"safe","password":"correct horse battery staple",'
                    '"api_key":"ordinary-secret-value"}'
                ),
            }
        ],
    })

    assert json.loads(assistant.process_message("run tool"))["status"] == "success"
    events = recorder.query({"sessionId": "python-cli"})
    root = next(event for event in events if event["kind"] == "trace.started")
    provider_started = next(
        event for event in events if event["kind"] == "provider.attempt.started"
    )
    provider_completed = next(
        event for event in events if event["kind"] == "provider.attempt.completed"
    )
    tool_started = next(event for event in events if event["kind"] == "tool.call.started")
    agent_started = next(
        event for event in events if event["kind"] == "agent.execute.started"
    )
    tool_completed = next(
        event for event in events if event["kind"] == "tool.call.completed"
    )

    assert provider_started["parentId"] == root["id"]
    assert provider_completed["parentId"] == provider_started["id"]
    assert provider_completed["model"] == "resolved-model"
    assert tool_started["parentId"] == provider_completed["id"]
    assert agent_started["parentId"] == tool_started["id"]
    assert tool_completed["parentId"] == tool_started["id"]
    assert tool_started["payload"]["arguments"]["password"] == "[redacted]"
    assert tool_started["payload"]["arguments"]["api_key"] == "[redacted]"


def test_python_cli_classifies_uppercase_error_tool_results():
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    registry = ToolRegistry()
    registry.agent.outcome = (
        '{"status":"ERROR","message":"command failed"}'
    )
    assistant = Assistant(registry)
    assistant.copilot = FakeCopilot({
        "content": None,
        "error": None,
        "model": "resolved-model",
        "tool_calls": [
            {
                "name": "RecordingAgent",
                "arguments": '{"query":"safe"}',
            }
        ],
    })

    assistant.process_message("run failing tool")

    assert recorder.query({"kind": "agent.execute.failed"})
    tool_failed = recorder.query({"kind": "tool.call.failed"})
    assert len(tool_failed) == 1
    assert tool_failed[0]["status"] == "error"
    assert tool_failed[0]["metadata"]["resultStatus"] == "error"
    assert recorder.query({"kind": "tool.call.completed"}) == []


def test_python_cli_provider_error_fallback_is_parented_as_a_tool_tree():
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    assistant = Assistant(ToolRegistry())
    assistant.copilot = FakeCopilot({
        "content": None,
        "tool_calls": None,
        "error": "provider offline",
        "model": "resolved-model",
    })

    result = json.loads(assistant.process_message("recordingagent please"))
    assert result["status"] == "success"
    events = recorder.query({"sessionId": "python-cli"})
    provider_failed = next(
        event for event in events if event["kind"] == "provider.attempt.failed"
    )
    tool_started = next(
        event for event in events if event["kind"] == "tool.call.started"
    )
    agent_started = next(
        event for event in events if event["kind"] == "agent.execute.started"
    )
    tool_completed = next(
        event for event in events if event["kind"] == "tool.call.completed"
    )

    assert tool_started["parentId"] == provider_failed["id"]
    assert tool_started["metadata"]["route"] == "provider-error-fallback"
    assert agent_started["parentId"] == tool_started["id"]
    assert tool_completed["parentId"] == tool_started["id"]


def test_python_cli_provider_error_without_match_does_not_fabricate_a_tool():
    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    assistant = Assistant(FakeRegistry())
    assistant.copilot = FakeCopilot({
        "content": None,
        "tool_calls": None,
        "error": "provider offline",
        "model": "resolved-model",
    })

    result = json.loads(assistant.process_message("hello"))
    assert result["status"] == "info"
    assert recorder.query({"kind": "provider.attempt.failed"})
    assert recorder.query({"kind": "tool.call.started"}) == []


def test_python_brainstem_records_provider_tool_and_agent_causality(monkeypatch):
    import openrappter.brainstem as brainstem

    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    agent = RecordingAgent(outcome='{"status":"success","value":7}')
    replies = iter(
        [
            (
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "function": {
                                "name": "RecordingAgent",
                                "arguments": '{"query":"safe"}',
                            },
                        }
                    ],
                },
                "resolved-model",
            ),
            (
                {
                    "role": "assistant",
                    "content": "done",
                },
                "resolved-model",
            ),
        ]
    )
    monkeypatch.setattr(
        brainstem,
        "load_agents",
        lambda: {"RecordingAgent": agent},
    )
    monkeypatch.setattr(brainstem, "load_soul", lambda: "system")
    monkeypatch.setattr(brainstem, "llm_chat", lambda _m, _t: next(replies))

    envelope = brainstem.run_chat("run tool", [], "brainstem-session")

    assert envelope["response"] == "done"
    events = recorder.query({"sessionId": "brainstem-session"})
    provider_started = next(
        event for event in events
        if event["kind"] == "provider.attempt.started"
    )
    provider_completed = next(
        event for event in events
        if event["kind"] == "provider.attempt.completed"
    )
    tool_started = next(
        event for event in events if event["kind"] == "tool.call.started"
    )
    agent_started = next(
        event for event in events if event["kind"] == "agent.execute.started"
    )
    assert provider_completed["parentId"] == provider_started["id"]
    assert tool_started["parentId"] == provider_completed["id"]
    assert agent_started["parentId"] == tool_started["id"]


def test_python_brainstem_keeps_unreported_model_unattributed(monkeypatch):
    import openrappter.brainstem as brainstem

    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    monkeypatch.setattr(brainstem, "load_agents", lambda: {})
    monkeypatch.setattr(brainstem, "load_soul", lambda: "system")
    monkeypatch.setattr(
        brainstem,
        "llm_chat",
        lambda _messages, _tools: (
            {"role": "assistant", "content": "answer"},
            None,
        ),
    )

    envelope = brainstem.run_chat("hello", [], "brainstem-model")

    assert envelope["model"].endswith(":unreported")
    completed = recorder.query(
        {"kind": "provider.attempt.completed"}
    )[0]
    assert "model" not in completed
    assert completed["metadata"]["modelPolicy"] == brainstem.MODEL


def test_python_brainstem_provider_only_turn_records_replay_io(monkeypatch):
    import openrappter.brainstem as brainstem

    recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(recorder)
    monkeypatch.setattr(brainstem, "load_agents", lambda: {})
    monkeypatch.setattr(brainstem, "load_soul", lambda: "system")
    monkeypatch.setattr(
        brainstem,
        "llm_chat",
        lambda _messages, _tools: (
            {
                "role": "assistant",
                "content": (
                    '{"password":"brain-response-secret",'
                    '"answer":"ok"}'
                ),
            },
            "resolved-model",
        ),
    )

    brainstem.run_chat(
        '{"password":"brain-prompt-secret","request":"hello"}',
        [],
        "brainstem-replay",
    )

    context = recorder.query({"kind": "context.assembled"})[0]
    started = recorder.query({"kind": "provider.attempt.started"})[0]
    completed = recorder.query({"kind": "provider.attempt.completed"})[0]
    assert context["payload"]["messages"][-1]["content"]["password"] == (
        "[redacted]"
    )
    assert started["payload"]["messages"] == context["payload"]["messages"]
    assert completed["payload"]["response"]["content"]["password"] == (
        "[redacted]"
    )
    exported = json.dumps(recorder.export())
    assert "brain-prompt-secret" not in exported
    assert "brain-response-secret" not in exported


def test_python_brainstem_legacy_agent_prefers_perform_abi(monkeypatch):
    import openrappter.brainstem as brainstem

    class LegacyAgent:
        name = "Legacy"
        metadata = {
            "name": "Legacy",
            "description": "legacy",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        }

        def execute(self, **_kwargs):
            return "execute-result"

        def perform(self, **_kwargs):
            return (
                '{"status":"success","path":"perform",'
                '"password":"result-secret-value"}'
            )

    recorder = in_memory_recorder(privacy={"recordIO": True})
    set_flight_recorder(recorder)
    replies = iter(
        [
            (
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "legacy-call",
                            "function": {
                                "name": "Legacy",
                                "arguments": "{}",
                            },
                        }
                    ],
                },
                None,
            ),
            ({"role": "assistant", "content": "done"}, None),
        ]
    )
    monkeypatch.setattr(
        brainstem,
        "load_agents",
        lambda: {"Legacy": LegacyAgent()},
    )
    monkeypatch.setattr(brainstem, "load_soul", lambda: "system")
    monkeypatch.setattr(
        brainstem,
        "llm_chat",
        lambda _messages, _tools: next(replies),
    )

    envelope = brainstem.run_chat("legacy", [], "legacy-session")

    assert '"path":"perform"' in envelope["agent_logs"]
    assert "execute-result" not in envelope["agent_logs"]
    assert "result-secret-value" not in json.dumps(recorder.export())


def test_python_copilot_timeout_records_provider_failure(monkeypatch):
    import asyncio

    class FakeSession:
        def on(self, _callback):
            pass

        async def send(self, _message):
            pass

        async def destroy(self):
            pass

    provider = CopilotProvider()
    provider._sdk_available = True

    async def create_session(_tools=None):
        return FakeSession()

    async def timeout_wait(_awaitable, timeout):
        assert timeout == 60
        if hasattr(_awaitable, "close"):
            _awaitable.close()
        raise asyncio.TimeoutError

    provider._create_session = create_session
    monkeypatch.setattr(asyncio, "wait_for", timeout_wait)

    recorder = in_memory_recorder()
    set_flight_recorder(recorder)
    assistant = Assistant(FakeRegistry())
    assistant.copilot = provider
    result = assistant.process_message("hello")

    assert json.loads(result)["status"] == "info"
    failed = recorder.query({"kind": "provider.attempt.failed"})
    assert len(failed) == 1
    assert failed[0]["metadata"]["errorName"] == "Error"
    assert failed[0]["metadata"]["messageChars"] == len(
        "Copilot request timed out after 60 seconds"
    )
    assert recorder.query({"kind": "provider.attempt.completed"}) == []


def test_importing_public_api_does_not_create_database(work_dir, monkeypatch):
    home = work_dir / "home"
    home.mkdir(mode=0o700)
    monkeypatch.setenv("HOME", str(home))
    assert get_flight_recorder().health()["enabled"] is False
    assert not (home / ".openrappter").exists()


def test_close_is_terminal_and_closed_inspection_fails():
    recorder = FlightRecorder(enabled=True, in_memory=True)
    recorder.close()
    assert recorder.record({"kind": "after-close", "source": "test"}) is None
    with pytest.raises(FlightRecorderUnhealthyError, match="closed"):
        recorder.query()
    with pytest.raises(FlightRecorderUnhealthyError, match="closed"):
        recorder.export()

    initialized = in_memory_recorder()
    initialized.close()
    with pytest.raises(FlightRecorderUnhealthyError, match="closed"):
        initialized.count()


def test_default_recorder_directory_is_hardened(
    work_dir,
    monkeypatch,
):
    home = work_dir / "managed-home"
    home.mkdir(mode=0o755)
    monkeypatch.setenv("HOME", str(home))
    managed = ensure_flight_recorder_from_env(
        {"OPENRAPPTER_FLIGHT_RECORDER": "1"}
    )
    managed.record({"kind": "managed", "source": "test"})
    assert stat.S_IMODE(
        (home / ".openrappter").stat().st_mode
    ) == 0o700


def test_environment_configuration_query_prune_count_and_clear(work_dir):
    database = work_dir / "configured" / "flight.db"
    recorder = ensure_flight_recorder_from_env(
        {
            "OPENRAPPTER_FLIGHT_RECORDER": "1",
            "OPENRAPPTER_FLIGHT_DB": str(database),
            "OPENRAPPTER_FLIGHT_RETENTION": "2",
            "OPENRAPPTER_FLIGHT_RECORD_IO": "1",
            "OPENRAPPTER_FLIGHT_MAX_PAYLOAD": "16",
        }
    )
    for index in range(3):
        recorder.record(
            {
                "traceId": "configured",
                "kind": f"event.{index}",
                "source": "test",
                "payload": {"text": "x" * 100},
            }
        )
    assert recorder.health()["databasePath"] == str(database)
    assert recorder.count() == 3
    assert len(recorder.query({"traceId": "configured"})) == 3
    assert recorder.query({"kind": "event.2"})[0]["payload"].startswith("[truncated:")
    assert recorder.prune(1) == 0
    assert recorder.count() == 3
    assert recorder.clear() is True
    assert recorder.count() == 0
