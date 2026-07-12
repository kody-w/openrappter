"""
End-to-end behavioral test: provider -> channel message flow through the
real Python GatewayServer.

This wires up only real components, talking over real local sockets:

  - a real OpenAI-compatible HTTP server (``http.server.ThreadingHTTPServer``,
    not a mocked function) bound to an OS-assigned ephemeral port
  - a real ``OpenAICompatibleProvider`` HTTP client pointed at it
  - a real ``WebhookChannel`` (its own ephemeral local HTTP listener) and
    ``ChannelRegistry``
  - a real ``ProviderChannelBridge`` wiring the channel to the provider
  - a real ``GatewayServer`` bound to 127.0.0.1:0 with token auth enabled,
    driven over a real ``aiohttp`` WebSocket client

Flow under test: an inbound HTTP POST to the webhook channel's own local
socket is treated as a channel message, routed through the configured
provider by the bridge, and the provider's response is sent back out
through the same channel — while channel lifecycle (`connect`/
`disconnect`/`probe`/`list`/`send`) is driven entirely through authenticated
Python WebSocket gateway RPC calls.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import aiohttp
import pytest
import requests

from openrappter.channels import ChannelRegistry, ProviderChannelBridge, WebhookChannel
from openrappter.gateway import GatewayServer, RPC_ERROR
from openrappter.providers import OpenAICompatibleProvider

TEST_TOKEN = "e2e-test-token-xyz"


# ── Fake OpenAI-compatible upstream servers (real sockets, not mocks) ───────


def _quiet(handler_cls):
    handler_cls.log_message = lambda *a, **k: None
    return handler_cls


class _FakeProviderServer:
    """Runs a real HTTP server on a background thread bound to 127.0.0.1:0."""

    def __init__(self, handler_cls):
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/v1"

    def shutdown(self) -> None:
        self._server.shutdown()
        self._thread.join(timeout=5)


def _make_echo_handler():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            last_user = next(
                (m["content"] for m in reversed(body.get("messages", [])) if m["role"] == "user"), ""
            )
            response = {
                "id": "chatcmpl-e2e",
                "object": "chat.completion",
                "created": 0,
                "model": body.get("model", "test-model"),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"provider-reply: {last_user}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5},
            }
            payload = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def _make_error_handler():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = b'{"error": {"message": "internal upstream failure"}}'
            self.send_response(500)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def _make_slow_handler(delay_seconds: float):
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            time.sleep(delay_seconds)
            payload = b"{}"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(payload)

    return Handler


# ── Gateway WS test harness (mirrors tests/test_gateway_server.py) ──────────


def run(coro):
    return asyncio.run(coro)


async def _connect_ws(server: GatewayServer, session: aiohttp.ClientSession):
    return await session.ws_connect(f"http://{server.host}:{server.port}/ws")


async def _rpc(ws, frame, timeout=10.0):
    await ws.send_str(json.dumps(frame))

    async def _wait_for_match():
        while True:
            msg = await ws.receive()
            if msg.type != aiohttp.WSMsgType.TEXT:
                raise AssertionError(f"expected TEXT message, got {msg.type!r}")
            data = json.loads(msg.data)
            if data.get("id") == frame.get("id"):
                return data

    return await asyncio.wait_for(_wait_for_match(), timeout=timeout)


async def _handshake(ws, token=TEST_TOKEN, frame_id="connect-1"):
    return await _rpc(
        ws,
        {
            "type": "req",
            "id": frame_id,
            "method": "connect",
            "params": {"client": {"id": "e2e-test"}, **({"auth": {"token": token}} if token else {})},
        },
    )


# ── The end-to-end test ─────────────────────────────────────────────────────


def test_provider_channel_e2e_through_authenticated_gateway():
    async def body():
        echo_server = _FakeProviderServer(_make_echo_handler())
        error_server = _FakeProviderServer(_make_error_handler())
        slow_server = _FakeProviderServer(_make_slow_handler(delay_seconds=2.0))

        registry = ChannelRegistry()

        good_channel = WebhookChannel(name="webhook-good", port=0, request_timeout=10.0)
        good_provider = OpenAICompatibleProvider(base_url=echo_server.base_url, timeout=5.0)
        good_bridge = ProviderChannelBridge(good_channel, good_provider, system_prompt="be terse")
        registry.register(good_channel)

        error_channel = WebhookChannel(name="webhook-error", port=0, request_timeout=10.0)
        error_provider = OpenAICompatibleProvider(base_url=error_server.base_url, timeout=5.0)
        error_bridge = ProviderChannelBridge(error_channel, error_provider)
        registry.register(error_channel)

        timeout_channel = WebhookChannel(name="webhook-timeout", port=0, request_timeout=10.0)
        # Provider's own bounded timeout is shorter than the slow server's
        # delay, so the provider call itself times out.
        timeout_provider = OpenAICompatibleProvider(base_url=slow_server.base_url, timeout=0.3)
        timeout_bridge = ProviderChannelBridge(timeout_channel, timeout_provider)
        registry.register(timeout_channel)

        good_bridge.start()
        error_bridge.start()
        timeout_bridge.start()

        server = GatewayServer(
            channel_registry=registry, host="127.0.0.1", port=0, token=TEST_TOKEN, version="e2e-test"
        )
        await server.start()

        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)

                # channels.* mutating methods require the connect handshake.
                pre_auth = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "pre-1",
                        "method": "channels.connect",
                        "params": {"channel_id": "webhook-good"},
                    },
                )
                assert pre_auth["ok"] is False
                assert pre_auth["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]

                handshake = await _handshake(ws)
                assert handshake["ok"] is True

                # channels.list before connecting anything.
                listed = await _rpc(ws, {"type": "req", "id": "list-1", "method": "channels.list", "params": {}})
                assert listed["ok"] is True
                by_id = {c["id"]: c for c in listed["payload"]}
                assert set(by_id) == {"webhook-good", "webhook-error", "webhook-timeout"}
                assert all(c["connected"] is False for c in by_id.values())

                # channels.connect (authenticated, idempotent) for all three channels.
                for channel_id in ("webhook-good", "webhook-error", "webhook-timeout"):
                    for _ in range(2):  # call twice to exercise idempotence over the wire
                        res = await _rpc(
                            ws,
                            {
                                "type": "req",
                                "id": f"connect-{channel_id}",
                                "method": "channels.connect",
                                "params": {"channel_id": channel_id},
                            },
                        )
                        assert res["ok"] is True
                        assert res["payload"]["connected"] is True

                # channels.probe reflects the now-connected state.
                probe = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "probe-1",
                        "method": "channels.probe",
                        "params": {"channel_id": "webhook-good"},
                    },
                )
                assert probe["ok"] is True
                assert probe["payload"]["ok"] is True

                # ── Inbound message -> provider -> outbound response ──────
                inbound_resp = requests.post(
                    good_channel.url,
                    json={"content": "hello from the e2e test", "conversation_id": "conv-e2e-1"},
                    timeout=10,
                )
                assert inbound_resp.status_code == 200
                assert inbound_resp.json()["content"] == "provider-reply: hello from the e2e test"
                assert inbound_resp.json()["conversation_id"] == "conv-e2e-1"

                # ── Provider failure surfaces as a bounded, explicit error ─
                error_resp = requests.post(
                    error_channel.url, json={"content": "trigger failure", "conversation_id": "conv-e2e-2"},
                    timeout=10,
                )
                assert error_resp.status_code == 502
                assert "internal upstream failure" not in error_resp.json()["error"]
                assert "HTTP 500" in error_resp.json()["error"]

                # ── Provider timeout surfaces as a bounded, explicit error ─
                timeout_resp = requests.post(
                    timeout_channel.url, json={"content": "trigger timeout", "conversation_id": "conv-e2e-3"},
                    timeout=10,
                )
                assert timeout_resp.status_code == 502
                assert "timed out" in timeout_resp.json()["error"]

                # ── channels.send: explicit/proactive send over the wire ──
                send_res = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "send-1",
                        "method": "channels.send",
                        "params": {
                            "channel_id": "webhook-good",
                            "conversation_id": "conv-proactive",
                            "content": "proactive notice",
                        },
                    },
                )
                assert send_res["ok"] is True
                assert send_res["payload"]["sent"] is True

                # ── channels.disconnect (authenticated, idempotent) + cleanup ─
                for _ in range(2):
                    disc = await _rpc(
                        ws,
                        {
                            "type": "req",
                            "id": "disconnect-good",
                            "method": "channels.disconnect",
                            "params": {"channel_id": "webhook-good"},
                        },
                    )
                    assert disc["ok"] is True
                    assert disc["payload"]["disconnected"] is True

                assert good_channel.connected is False
                assert good_bridge.active is True
                assert len(good_channel._handlers) == 1
                assert good_channel._pending == {}

                # The channel's own local listener socket is gone, so a
                # direct POST must now fail outright rather than hang or
                # silently succeed.
                with pytest.raises(requests.exceptions.ConnectionError):
                    requests.post(
                        good_channel.url, json={"content": "should fail", "conversation_id": "after-disconnect"},
                        timeout=3,
                    )

                # channels.list reflects the disconnect.
                listed_after = await _rpc(
                    ws, {"type": "req", "id": "list-2", "method": "channels.list", "params": {}}
                )
                by_id_after = {c["id"]: c for c in listed_after["payload"]}
                assert by_id_after["webhook-good"]["connected"] is False

                # Unknown channel -> explicit INVALID_PARAMS error, not a crash.
                missing = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "missing-1",
                        "method": "channels.connect",
                        "params": {"channel_id": "does-not-exist"},
                    },
                )
                assert missing["ok"] is False
                assert missing["error"]["code"] == RPC_ERROR["INVALID_PARAMS"]

                good_bridge.stop()
                assert good_bridge.active is False
                assert good_channel._handlers == []
                await ws.close()
        finally:
            await server.stop()
            for bridge in (good_bridge, error_bridge, timeout_bridge):
                bridge.stop()
            for channel in (good_channel, error_channel, timeout_channel):
                channel.disconnect()
            for fake_server in (echo_server, error_server, slow_server):
                fake_server.shutdown()

    run(body())


def test_channels_methods_blocked_before_handshake_regardless_of_method():
    """The gateway's mandatory `connect` handshake gate applies uniformly —
    read-only methods (`channels.list`/`channels.probe`) are blocked
    exactly like mutating ones (`channels.send`) until a connection has
    completed the handshake."""

    async def body():
        registry = ChannelRegistry()
        channel = WebhookChannel(name="wh-open", port=0)
        registry.register(channel)
        server = GatewayServer(
            channel_registry=registry, host="127.0.0.1", port=0, token=TEST_TOKEN, version="e2e-test"
        )
        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                # No handshake performed at all.
                listed = await _rpc(ws, {"type": "req", "id": "l1", "method": "channels.list", "params": {}})
                assert listed["ok"] is False
                assert listed["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]

                mutate = await _rpc(
                    ws,
                    {"type": "req", "id": "m1", "method": "channels.send", "params": {
                        "channel_id": "wh-open", "conversation_id": "c1", "content": "hi",
                    }},
                )
                assert mutate["ok"] is False
                assert mutate["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]
                await ws.close()

                # After a proper handshake, both read-only and mutating
                # channels.* methods succeed on a fresh connection.
                ws2 = await _connect_ws(server, session)
                await _handshake(ws2, frame_id="connect-2")
                listed2 = await _rpc(ws2, {"type": "req", "id": "l2", "method": "channels.list", "params": {}})
                assert listed2["ok"] is True
                probed2 = await _rpc(
                    ws2,
                    {"type": "req", "id": "p2", "method": "channels.probe", "params": {"channel_id": "wh-open"}},
                )
                assert probed2["ok"] is True
                assert probed2["payload"]["ok"] is False  # not connected
                await ws2.close()
        finally:
            await server.stop()

    run(body())


def test_channels_send_reachable_after_handshake_on_no_token_loopback_gateway():
    """On a loopback gateway with no token configured (auth-disabled mode),
    the handshake alone is sufficient to reach `requires_auth` methods —
    there is no separate credential to withhold."""

    async def body():
        registry = ChannelRegistry()
        channel = WebhookChannel(name="wh-open2", port=0)
        registry.register(channel)
        server = GatewayServer(channel_registry=registry, host="127.0.0.1", port=0, token=None, version="e2e-test")
        assert server.auth_enabled is False
        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                handshake = await _handshake(ws, token=None)
                assert handshake["ok"] is True

                connect_res = await _rpc(
                    ws,
                    {"type": "req", "id": "c1", "method": "channels.connect", "params": {"channel_id": "wh-open2"}},
                )
                assert connect_res["ok"] is True
                assert connect_res["payload"]["connected"] is True

                disconnect_res = await _rpc(
                    ws,
                    {"type": "req", "id": "d1", "method": "channels.disconnect", "params": {"channel_id": "wh-open2"}},
                )
                assert disconnect_res["ok"] is True
                await ws.close()
        finally:
            await server.stop()
            channel.disconnect()

    run(body())


def test_channels_methods_return_empty_or_error_without_registry():
    async def body():
        server = GatewayServer(host="127.0.0.1", port=0, token=TEST_TOKEN, version="e2e-test")
        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                listed = await _rpc(ws, {"type": "req", "id": "l1", "method": "channels.list", "params": {}})
                assert listed["ok"] is True
                assert listed["payload"] == []

                connect_res = await _rpc(
                    ws, {"type": "req", "id": "c1", "method": "channels.connect", "params": {"channel_id": "x"}}
                )
                assert connect_res["ok"] is False
                assert connect_res["error"]["code"] == RPC_ERROR["INTERNAL_ERROR"]
                await ws.close()
        finally:
            await server.stop()

    run(body())
