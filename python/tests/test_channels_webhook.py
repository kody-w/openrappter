"""
Behavioral tests for openrappter.channels.webhook.WebhookChannel.

Every test binds a real WebhookChannel to a real ephemeral local TCP port
and talks to it with a real ``requests`` HTTP client — no mocks.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from openrappter.channels.base import IncomingMessage, OutgoingMessage
from openrappter.channels.webhook import WebhookChannel


def test_connect_binds_ephemeral_port_and_is_idempotent():
    channel = WebhookChannel(name="wh1", port=0)
    assert channel.connected is False
    channel.connect()
    assert channel.connected is True
    assert channel.port != 0
    first_port = channel.port

    # Idempotent: calling connect() again is a no-op, same port stays bound.
    channel.connect()
    assert channel.port == first_port
    assert channel.connected is True

    channel.disconnect()
    assert channel.connected is False


def test_disconnect_is_idempotent_when_never_connected():
    channel = WebhookChannel(name="wh2", port=0)
    channel.disconnect()
    channel.disconnect()
    assert channel.connected is False


def test_inbound_post_round_trips_through_handler_to_response():
    channel = WebhookChannel(name="wh3", port=0)
    channel.connect()
    try:
        def handler(message: IncomingMessage) -> None:
            channel.send(
                message.conversation_id,
                OutgoingMessage(
                    channel_id=message.channel_id,
                    conversation_id=message.conversation_id,
                    content=f"reply to: {message.content}",
                ),
            )

        channel.on_message(handler)

        resp = requests.post(
            channel.url,
            json={"content": "ping", "conversation_id": "conv-1", "sender_id": "user-1"},
            timeout=10,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["content"] == "reply to: ping"
        assert body["conversation_id"] == "conv-1"
        # message_count tracks both directions: 1 inbound (emit_message)
        # + 1 outbound (send).
        assert channel.message_count == 2
    finally:
        channel.disconnect()


def test_missing_content_returns_400():
    channel = WebhookChannel(name="wh4", port=0)
    channel.connect()
    try:
        resp = requests.post(channel.url, json={"conversation_id": "c1"}, timeout=10)
        assert resp.status_code == 400
    finally:
        channel.disconnect()


def test_invalid_json_body_returns_400():
    channel = WebhookChannel(name="wh5", port=0)
    channel.connect()
    try:
        resp = requests.post(
            channel.url, data=b"not json", headers={"Content-Type": "application/json"}, timeout=10
        )
        assert resp.status_code == 400
    finally:
        channel.disconnect()


def test_handler_exception_returns_502():
    channel = WebhookChannel(name="wh6", port=0)
    channel.connect()
    try:
        def bad_handler(message: IncomingMessage) -> None:
            raise RuntimeError("handler boom")

        channel.on_message(bad_handler)
        resp = requests.post(channel.url, json={"content": "hi"}, timeout=10)
        assert resp.status_code == 502
        assert "handler boom" in resp.json()["error"]
    finally:
        channel.disconnect()


def test_no_response_times_out_with_504():
    channel = WebhookChannel(name="wh7", port=0, request_timeout=0.3)
    channel.connect()
    try:
        # No handler registered at all -> nothing ever calls send() -> the
        # request must time out rather than hang forever.
        resp = requests.post(channel.url, json={"content": "hi"}, timeout=10)
        assert resp.status_code == 504
    finally:
        channel.disconnect()


def test_send_without_pending_request_does_not_raise():
    channel = WebhookChannel(name="wh8", port=0)
    channel.connect()
    try:
        channel.send("no-such-conversation", OutgoingMessage(
            channel_id="wh8", conversation_id="no-such-conversation", content="orphan reply"
        ))
        assert channel.message_count == 1
    finally:
        channel.disconnect()


def test_disconnect_cleans_pending_work_but_preserves_subscriptions():
    channel = WebhookChannel(name="wh9", port=0, request_timeout=5.0)
    channel.connect()

    calls = []
    unsubscribe = channel.on_message(lambda msg: calls.append(msg))
    assert len(channel._handlers) == 1

    channel.disconnect()

    # A subscription belongs to the channel object, not one transport
    # connection, so bridges remain attached across reconnects.
    assert len(channel._handlers) == 1
    assert channel._pending == {}
    assert channel.connected is False
    unsubscribe()
    assert channel._handlers == []


def test_reconnect_after_disconnect_gets_fresh_ephemeral_port_and_works():
    channel = WebhookChannel(name="wh10", port=0)
    channel.connect()
    first_port = channel.port
    channel.disconnect()

    channel.connect()
    try:
        def handler(message: IncomingMessage) -> None:
            channel.send(
                message.conversation_id,
                OutgoingMessage(channel_id=message.channel_id, conversation_id=message.conversation_id, content="ok"),
            )

        channel.on_message(handler)
        resp = requests.post(channel.url, json={"content": "hi", "conversation_id": "c"}, timeout=10)
        assert resp.status_code == 200
        assert resp.json()["content"] == "ok"
    finally:
        channel.disconnect()


def test_blocking_sync_handler_does_not_block_aiohttp_loop():
    channel = WebhookChannel(
        name="wh-nonblocking",
        port=0,
        request_timeout=0.5,
        max_handler_workers=1,
    )
    entered = threading.Event()
    release = threading.Event()

    def blocking_handler(message: IncomingMessage) -> None:
        entered.set()
        release.wait(timeout=0.5)
        channel.send(
            message.conversation_id,
            OutgoingMessage(
                channel_id=message.channel_id,
                conversation_id=message.conversation_id,
                content="done",
            ),
        )

    channel.on_message(blocking_handler)
    channel.connect()
    try:
        with ThreadPoolExecutor(max_workers=1) as clients:
            blocked_request = clients.submit(
                requests.post,
                channel.url,
                json={"content": "block", "conversation_id": "blocked"},
                timeout=1,
            )
            assert entered.wait(timeout=0.2)

            started = time.monotonic()
            invalid = requests.post(
                channel.url,
                json={"conversation_id": "still-responsive"},
                timeout=0.2,
            )
            elapsed = time.monotonic() - started
            assert invalid.status_code == 400
            assert elapsed < 0.15

            release.set()
            assert blocked_request.result(timeout=0.5).status_code == 200
    finally:
        release.set()
        channel.disconnect()


def test_request_timeout_covers_sync_handler_and_disconnect_is_bounded():
    channel = WebhookChannel(
        name="wh-timeout",
        port=0,
        request_timeout=0.04,
        max_handler_workers=1,
    )
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    disconnect_done = threading.Event()
    disconnect_errors = []

    def blocking_handler(message: IncomingMessage) -> None:
        entered.set()
        release.wait(timeout=0.5)
        finished.set()

    def disconnect() -> None:
        try:
            channel.disconnect()
        except BaseException as exc:  # surfaced in the test thread
            disconnect_errors.append(exc)
        finally:
            disconnect_done.set()

    channel.on_message(blocking_handler)
    channel.connect()
    started = time.monotonic()
    response = requests.post(
        channel.url,
        json={"content": "slow", "conversation_id": "slow"},
        timeout=0.5,
    )
    elapsed = time.monotonic() - started

    assert entered.is_set()
    assert response.status_code == 504
    assert elapsed < 0.2
    assert channel._worker_futures

    shutdown_thread = threading.Thread(target=disconnect)
    shutdown_thread.start()
    shutdown_thread.join(timeout=0.5)

    assert not shutdown_thread.is_alive()
    assert disconnect_errors == []
    assert not finished.is_set()
    assert channel._request_tasks == set()
    assert channel._handler_tasks == set()
    assert channel._worker_futures
    assert "slow" in channel._pending
    assert all(worker.daemon for worker in channel._handler_pool.threads)

    release.set()
    assert finished.wait(timeout=0.5)
    for _ in range(100):
        if not channel._worker_futures and not channel._pending:
            break
        time.sleep(0.005)
    assert channel._worker_futures == {}
    assert channel._pending == {}


def test_sync_handler_executor_has_no_unbounded_queue():
    channel = WebhookChannel(
        name="wh-bounded",
        port=0,
        request_timeout=0.06,
        max_handler_workers=1,
    )
    entered = threading.Event()
    release = threading.Event()
    calls = 0
    calls_lock = threading.Lock()

    def blocking_handler(message: IncomingMessage) -> None:
        nonlocal calls
        with calls_lock:
            calls += 1
        entered.set()
        release.wait(timeout=0.5)

    channel.on_message(blocking_handler)
    channel.connect()
    try:
        with ThreadPoolExecutor(max_workers=2) as clients:
            requests_in_flight = [
                clients.submit(
                    requests.post,
                    channel.url,
                    json={"content": "slow", "conversation_id": f"slow-{index}"},
                    timeout=0.5,
                )
                for index in range(2)
            ]
            assert entered.wait(timeout=0.2)
            responses = [request.result(timeout=0.3) for request in requests_in_flight]
            assert [response.status_code for response in responses] == [504, 504]
            with calls_lock:
                assert calls == 1
    finally:
        release.set()
        channel.disconnect()


def test_timed_out_generation_stays_reserved_until_its_worker_finishes():
    channel = WebhookChannel(
        name="wh-generation",
        port=0,
        request_timeout=0.15,
        max_handler_workers=1,
    )
    old_entered = threading.Event()
    release_old = threading.Event()
    new_entered = threading.Event()
    release_new = threading.Event()

    def handler(message: IncomingMessage) -> None:
        if message.content == "old":
            old_entered.set()
            release_old.wait()
            reply = "old reply"
        else:
            new_entered.set()
            release_new.wait(timeout=0.1)
            reply = "new reply"
        channel.send(
            message.conversation_id,
            OutgoingMessage(
                channel_id=message.channel_id,
                conversation_id=message.conversation_id,
                content=reply,
                request_generation=message.request_generation,
            ),
        )

    channel.on_message(handler)
    channel.connect()
    try:
        old = requests.post(
            channel.url,
            json={"content": "old", "conversation_id": "reused"},
            timeout=0.5,
        )
        assert old.status_code == 504
        assert old_entered.is_set()
        old_generation = channel._pending["reused"].generation

        duplicate = requests.post(
            channel.url,
            json={"content": "new", "conversation_id": "reused"},
            timeout=0.5,
        )
        assert duplicate.status_code == 409
        assert channel._pending["reused"].generation == old_generation

        release_old.set()
        for _ in range(100):
            if "reused" not in channel._pending:
                break
            time.sleep(0.005)
        assert "reused" not in channel._pending

        with ThreadPoolExecutor(max_workers=1) as clients:
            fresh_request = clients.submit(
                requests.post,
                channel.url,
                json={"content": "new", "conversation_id": "reused"},
                timeout=0.5,
            )
            assert new_entered.wait(timeout=0.1)
            channel.send(
                "reused",
                OutgoingMessage(
                    channel_id=channel.name,
                    conversation_id="reused",
                    content="stale old reply",
                    request_generation=old_generation,
                ),
            )
            time.sleep(0.02)
            assert fresh_request.done() is False
            release_new.set()
            fresh = fresh_request.result(timeout=0.3)
        assert fresh.status_code == 200
        assert fresh.json()["content"] == "new reply"
    finally:
        release_old.set()
        release_new.set()
        channel.disconnect()


def test_disconnect_returns_with_truly_hung_handler_on_daemon_worker():
    channel = WebhookChannel(
        name="wh-hung",
        port=0,
        request_timeout=0.04,
        max_handler_workers=1,
    )
    entered = threading.Event()

    def hung_handler(message: IncomingMessage) -> None:
        entered.set()
        threading.Event().wait()

    channel.on_message(hung_handler)
    channel.connect()
    response = requests.post(
        channel.url,
        json={"content": "hang", "conversation_id": "hung"},
        timeout=0.5,
    )
    assert response.status_code == 504
    assert entered.is_set()

    started = time.monotonic()
    channel.disconnect()
    elapsed = time.monotonic() - started
    assert elapsed < 0.5
    assert channel.connected is False
    assert "hung" in channel._pending
    assert channel._handler_pool.in_flight == 1
    workers = channel._handler_pool.threads
    assert workers
    assert all(worker.daemon for worker in workers)
    assert not any(
        worker.name.startswith("webhook-handler-wh-hung") and not worker.daemon
        for worker in threading.enumerate()
    )
