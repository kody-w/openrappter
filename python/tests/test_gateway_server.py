"""
Behavioral tests for openrappter.gateway.GatewayServer.

These tests exercise the real async server over real ephemeral TCP sockets
(HTTP + WebSocket), not mocks — every test binds an actual GatewayServer to
127.0.0.1:0 (OS-assigned free port) and talks to it with a real aiohttp
client. Mirrors the intent of typescript/src/gateway/gateway.protocol.test.ts.
"""

import asyncio
import json
import signal
import threading
import time
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import aiohttp
import pytest
from aiohttp import web

from openrappter.gateway import GatewayServer, GatewayError, RPC_ERROR

TEST_TOKEN = "test-token-abc123"


class FakeAgent:
    """Minimal agent implementing the BasicAgent.execute() contract."""

    def __init__(self, name="EchoAgent", raise_error=False):
        self.name = name
        self._raise_error = raise_error

    def execute(self, **kwargs):
        if self._raise_error:
            raise RuntimeError("boom")
        return json.dumps({"status": "success", "echo": kwargs})


class FakeRegistry:
    """Minimal registry implementing AgentRegistry.get_agent()/list_agents()."""

    def __init__(self, agents=None):
        self._agents = agents or {"EchoAgent": FakeAgent()}

    def get_agent(self, name):
        return self._agents.get(name)

    def list_agents(self):
        return [{"name": name, "description": "fake"} for name in self._agents]


class WireChannelRegistry:
    def __init__(self):
        self.sent = []

    def get_status_list(self):
        return [
            {
                "id": "wire",
                "type": "webhook",
                "connected": True,
                "message_count": 7,
            }
        ]

    def send_message(self, channel_id, conversation_id, content):
        self.sent.append((channel_id, conversation_id, content))


class BlockingAgent:
    def __init__(self):
        self.name = "BlockingAgent"
        self.release = threading.Event()
        self.calls = 0
        self._lock = threading.Lock()

    def execute(self, **kwargs):
        with self._lock:
            self.calls += 1
        self.release.wait(timeout=5)
        return json.dumps({"status": "success", "calls": self.calls})


class HungAgent:
    def __init__(self):
        self.name = "HungAgent"
        self.entered = threading.Event()

    def execute(self, **kwargs):
        self.entered.set()
        threading.Event().wait()


def run(coro):
    """Run an async test body to completion (no pytest-asyncio dependency)."""
    return asyncio.run(coro)


async def _start_server(**kwargs) -> GatewayServer:
    defaults = dict(
        agent_registry=FakeRegistry(),
        host="127.0.0.1",
        port=0,
        token=TEST_TOKEN,
        version="test",
    )
    defaults.update(kwargs)
    server = GatewayServer(**defaults)
    await server.start()
    return server


async def _connect_ws(server: GatewayServer, session: aiohttp.ClientSession):
    return await session.ws_connect(f"http://{server.host}:{server.port}/ws")


async def _rpc(ws, frame, timeout=5.0):
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
            "params": {"client": {"id": "test"}, **({"auth": {"token": token}} if token else {})},
        },
    )


# ── Construction / config validation ────────────────────────────────────


def test_non_loopback_host_requires_token():
    with pytest.raises(ValueError):
        GatewayServer(host="0.0.0.0", port=0, token=None)


def test_loopback_host_allows_no_token():
    server = GatewayServer(host="127.0.0.1", port=0, token=None)
    assert server.auth_enabled is False


def test_trusted_origins_require_token_and_valid_exact_origins():
    with pytest.raises(ValueError, match="requires gateway token"):
        GatewayServer(
            host="127.0.0.1",
            port=0,
            token=None,
            trusted_origins=["https://dashboard.example"],
        )

    for origin in (
        "https://*.example",
        "https://dashboard.example/path",
        "null",
        "file:///dashboard",
    ):
        with pytest.raises(ValueError, match="Invalid trusted WebSocket origin"):
            GatewayServer(
                host="127.0.0.1",
                port=0,
                token=TEST_TOKEN,
                trusted_origins=[origin],
            )


# ── HTTP endpoints ───────────────────────────────────────────────────────


def test_http_health_and_status():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/health") as resp:
                    assert resp.status == 200
                    health = await resp.json()
                    assert health["status"] == "ok"

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    assert resp.status == 200
                    status = await resp.json()
                    assert status["running"] is True
                    assert status["port"] == server.port
        finally:
            await server.stop()

    run(body())


def test_status_health_ping_and_metrics_match_typescript_wire_contracts():
    """Expected keys mirror GatewayStatus, HealthResponse, PingResponse,
    and GatewayMetricsSnapshot in typescript/src/gateway."""

    async def body():
        server = await _start_server()
        expected_metrics = {
            "rpcRequestsTotal",
            "rpcSuccessTotal",
            "rpcErrorsTotal",
            "rpcAuthFailuresTotal",
            "rpcRateLimitedTotal",
            "rpcTimeoutsTotal",
            "activeConnections",
            "activeAgentExecutions",
            "uptimeSeconds",
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                async with session.get(f"http://{server.host}:{server.port}/health") as resp:
                    health = await resp.json()

                assert set(status) == {
                    "running", "port", "connections", "uptime",
                    "version", "startedAt", "metrics",
                }
                assert set(status["metrics"]) == expected_metrics
                assert isinstance(status["uptime"], int)
                started_at = datetime.fromisoformat(
                    status["startedAt"].replace("Z", "+00:00")
                )
                assert started_at.tzinfo is not None

                assert set(health) == {
                    "status", "version", "uptime", "timestamp", "checks", "metrics",
                }
                assert set(health["metrics"]) == expected_metrics
                health_at = datetime.fromisoformat(
                    health["timestamp"].replace("Z", "+00:00")
                )
                assert health_at.tzinfo is not None

                ws = await _connect_ws(server, session)
                await _handshake(ws)
                lower_bound = time.time_ns() // 1_000_000
                ping = await _rpc(
                    ws,
                    {"type": "req", "id": "ping-contract", "method": "ping", "params": {}},
                )
                upper_bound = time.time_ns() // 1_000_000
                pong = ping["payload"]["pong"]
                assert isinstance(pong, int) and not isinstance(pong, bool)
                assert lower_bound <= pong <= upper_bound

                rpc_status = await _rpc(
                    ws,
                    {"type": "req", "id": "status-contract", "method": "status", "params": {}},
                )
                rpc_health = await _rpc(
                    ws,
                    {"type": "req", "id": "health-contract", "method": "health", "params": {}},
                )
                assert set(rpc_status["payload"]) == set(status)
                assert set(rpc_health["payload"]) == set(health)
                assert set(rpc_status["payload"]["metrics"]) == expected_metrics
                assert set(rpc_health["payload"]["metrics"]) == expected_metrics
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Connect handshake ────────────────────────────────────────────────────


def test_tokenless_loopback_accepts_originless_and_exact_same_origin_clients():
    async def body():
        server = await _start_server(token=None)
        try:
            async with aiohttp.ClientSession() as session:
                originless = await _connect_ws(server, session)
                assert (await _handshake(originless, token=None))["ok"] is True
                await originless.close()

                same_origin = await session.ws_connect(
                    f"http://{server.host}:{server.port}/ws",
                    origin=f"http://{server.host}:{server.port}",
                )
                assert (await _handshake(same_origin, token=None))["ok"] is True
                await same_origin.close()

                localhost_origin = await session.ws_connect(
                    f"http://{server.host}:{server.port}/ws",
                    headers={
                        "Host": f"localhost:{server.port}",
                        "Origin": f"http://localhost:{server.port}",
                    },
                )
                assert (await _handshake(localhost_origin, token=None))["ok"] is True
                await localhost_origin.close()
        finally:
            await server.stop()

    run(body())


def test_websocket_rejects_malicious_origins_before_upgrade_even_with_token():
    async def body():
        server = await _start_server()
        url = f"http://{server.host}:{server.port}/ws"
        rejected_origins = (
            "https://evil.example",
            f"http://{server.host}:{server.port + 1}",
            "null",
            f"http://user@{server.host}:{server.port}",
        )
        try:
            async with aiohttp.ClientSession() as session:
                for origin in rejected_origins:
                    with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
                        await session.ws_connect(url, origin=origin)
                    assert excinfo.value.status == 403
                    assert server.connection_count == 0

                with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
                    await session.ws_connect(
                        url,
                        headers=[
                            ("Origin", f"http://{server.host}:{server.port}"),
                            ("Origin", "https://evil.example"),
                        ],
                    )
                assert excinfo.value.status == 403
                assert server.connection_count == 0
        finally:
            await server.stop()

    run(body())


def test_websocket_rejects_dns_rebinding_and_wrong_port_host_headers():
    async def body():
        server = await _start_server()
        url = f"http://{server.host}:{server.port}/ws"
        try:
            async with aiohttp.ClientSession() as session:
                for host in (
                    f"attacker.example:{server.port}",
                    f"{server.host}:{server.port + 1}",
                    f"127.0.0.2:{server.port}",
                ):
                    with pytest.raises(aiohttp.WSServerHandshakeError) as excinfo:
                        await session.ws_connect(url, headers={"Host": host})
                    assert excinfo.value.status == 403
                    assert server.connection_count == 0
        finally:
            await server.stop()

    run(body())


def test_token_authenticated_gateway_accepts_only_explicit_cross_origin():
    async def body():
        trusted_origin = "https://dashboard.example"
        server = await _start_server(trusted_origins=[trusted_origin])
        try:
            async with aiohttp.ClientSession() as session:
                ws = await session.ws_connect(
                    f"http://{server.host}:{server.port}/ws",
                    origin=trusted_origin,
                )
                assert (await _handshake(ws))["ok"] is True
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_handshake_required_before_other_rpcs():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                res = await _rpc(ws, {"type": "req", "id": "s1", "method": "status", "params": {}})
                assert res["ok"] is False
                assert res["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_handshake_with_correct_token_succeeds():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                res = await _handshake(ws)
                assert res["ok"] is True
                assert res["payload"]["type"] == "hello-ok"
                assert res["payload"]["protocol"] == 3
                assert "ping" in res["payload"]["features"]["methods"]
                assert "connect" not in res["payload"]["features"]["methods"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_handshake_with_wrong_token_fails():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                res = await _handshake(ws, token="totally-wrong")
                assert res["ok"] is False
                assert res["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_handshake_without_token_in_auth_disabled_mode():
    async def body():
        server = await _start_server(token=None)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                res = await _handshake(ws, token=None)
                assert res["ok"] is True
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Authenticated protected methods ─────────────────────────────────────


def test_agents_execute_requires_auth_and_wires_to_registry():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)

                # Protected method rejected before handshake.
                pre = await _rpc(
                    ws,
                    {"type": "req", "id": "exec-pre", "method": "agents.execute",
                     "params": {"name": "EchoAgent"}},
                )
                assert pre["ok"] is False
                assert pre["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]

                await _handshake(ws)

                res = await _rpc(
                    ws,
                    {"type": "req", "id": "exec-1", "method": "agents.execute",
                     "params": {"name": "EchoAgent", "kwargs": {"query": "hi"}}},
                )
                assert res["ok"] is True
                assert res["payload"]["status"] == "success"
                assert res["payload"]["echo"] == {"query": "hi"}

                listing = await _rpc(ws, {"type": "req", "id": "list-1", "method": "agents.list", "params": {}})
                assert listing["ok"] is True
                assert any(a["name"] == "EchoAgent" for a in listing["payload"])

                unknown = await _rpc(
                    ws,
                    {"type": "req", "id": "exec-2", "method": "agents.execute",
                     "params": {"name": "NoSuchAgent"}},
                )
                assert unknown["ok"] is False
                assert unknown["error"]["code"] == RPC_ERROR["INVALID_PARAMS"]

                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_agents_execute_against_real_agent_registry(tmp_path, monkeypatch):
    """Prove the wiring against the real CLI AgentRegistry / BasicAgent.execute() contract."""
    from openrappter.cli import AgentRegistry

    isolated_home = tmp_path / "home"
    agents_dir = tmp_path / "agents"
    skills_dir = isolated_home / ".openrappter" / "skills"
    isolated_home.mkdir()
    agents_dir.mkdir()
    (agents_dir / "isolated_agent.py").write_text(
        """
import json
from openrappter.agents.basic_agent import BasicAgent

class IsolatedAgent(BasicAgent):
    def __init__(self):
        super().__init__("Isolated", {
            "name": "Isolated",
            "description": "isolated gateway test agent",
            "parameters": {"type": "object", "properties": {}, "required": []},
        })

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "isolated": True})
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(isolated_home))
    registry = AgentRegistry(agents_dir=agents_dir, skills_dir=skills_dir)

    async def body():
        server = await _start_server(agent_registry=registry)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(
                    ws,
                    {"type": "req", "id": "isolated-1", "method": "agents.execute",
                     "params": {"name": "Isolated", "kwargs": {"query": "hello"}}},
                )
                assert res["ok"] is True
                assert res["payload"]["isolated"] is True
                await ws.close()
        finally:
            await server.stop()

    run(body())
    assert registry.agents_dir == agents_dir
    assert registry.skills_dir == skills_dir
    assert skills_dir.is_dir()
    assert Path.home() == isolated_home


# ── Separate-client isolation ───────────────────────────────────────────


def test_separate_clients_have_isolated_auth_state():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws_a = await _connect_ws(server, session)
                ws_b = await _connect_ws(server, session)

                hello_a = await _handshake(ws_a, frame_id="a-connect")
                assert hello_a["ok"] is True
                conn_id_a = hello_a["payload"]["server"]["connId"]

                # B never completes the handshake — its non-connect calls must fail
                # even though A is fully authenticated on the same server.
                b_status = await _rpc(ws_b, {"type": "req", "id": "b-status", "method": "status", "params": {}})
                assert b_status["ok"] is False
                assert b_status["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]

                a_status = await _rpc(ws_a, {"type": "req", "id": "a-status", "method": "status", "params": {}})
                assert a_status["ok"] is True
                assert a_status["payload"]["connections"] == 2

                hello_b = await _handshake(ws_b, frame_id="b-connect")
                assert hello_b["ok"] is True
                conn_id_b = hello_b["payload"]["server"]["connId"]
                assert conn_id_a != conn_id_b

                await ws_a.close()
                await ws_b.close()
        finally:
            await server.stop()

    run(body())


# ── Unknown method ───────────────────────────────────────────────────────


def test_unknown_method_returns_stable_error():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(ws, {"type": "req", "id": "nope", "method": "does.not.exist", "params": {}})
                assert res["ok"] is False
                assert res["error"]["code"] == RPC_ERROR["METHOD_NOT_FOUND"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Bounded message size ────────────────────────────────────────────────


def test_oversized_message_closes_connection():
    async def body():
        server = await _start_server(max_message_bytes=200)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                oversized = json.dumps(
                    {"type": "req", "id": "big", "method": "ping", "params": {"pad": "x" * 5000}}
                )
                await ws.send_str(oversized)

                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                assert msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR)
        finally:
            await server.stop()

    run(body())


# ── Bounded request rate ─────────────────────────────────────────────────


def test_rate_limit_bound():
    async def body():
        server = await _start_server(rate_limit_max=3, rate_limit_window=60.0)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                results = []
                for i in range(5):
                    res = await _rpc(ws, {"type": "req", "id": f"p{i}", "method": "ping", "params": {}})
                    results.append(res)

                assert any(r["ok"] is False and r["error"]["code"] == RPC_ERROR["RATE_LIMITED"] for r in results)
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Bounded execution timeout ────────────────────────────────────────────


def test_execution_timeout_bound():
    async def body():
        server = await _start_server(execution_timeout=0.2)

        async def slow_handler(params, info):
            await asyncio.sleep(2)
            return {"never": "seen"}

        server.register_method("slow", slow_handler)

        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(ws, {"type": "req", "id": "slow-1", "method": "slow", "params": {}}, timeout=5)
                assert res["ok"] is False
                assert res["error"]["code"] == RPC_ERROR["TIMEOUT"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_timed_out_sync_agents_hold_bounded_dedicated_worker_slots():
    async def body():
        agent = BlockingAgent()
        registry = FakeRegistry({"BlockingAgent": agent})
        server = await _start_server(
            agent_registry=registry,
            execution_timeout=0.1,
            max_agent_workers=1,
        )
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                frame = {
                    "type": "req",
                    "method": "agents.execute",
                    "params": {"name": "BlockingAgent"},
                }

                first = await _rpc(ws, {**frame, "id": "blocked-1"})
                assert first["error"]["code"] == RPC_ERROR["TIMEOUT"]
                assert agent.calls == 1

                # The first sync call is still running after its client timeout.
                # A second request must not enter an unbounded executor queue.
                second = await _rpc(ws, {**frame, "id": "blocked-2"})
                assert second["error"]["code"] == RPC_ERROR["TIMEOUT"]
                assert agent.calls == 1

                agent.release.set()
                for _ in range(50):
                    await asyncio.sleep(0.01)
                    if server._worker_pool.in_flight == 0:
                        break

                third = await _rpc(ws, {**frame, "id": "blocked-3"})
                assert third["ok"] is True
                assert agent.calls == 2
                await ws.close()
        finally:
            agent.release.set()
            await server.stop()

    run(body())


# ── Canonical channel wire adapter ──────────────────────────────────────


def test_channels_send_accepts_canonical_and_legacy_keys_and_emits_canonical_dtos():
    async def body():
        channels = WireChannelRegistry()
        server = await _start_server(channel_registry=channels)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                canonical = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "send-canonical",
                        "method": "channels.send",
                        "params": {
                            "channelId": "wire",
                            "conversationId": "camel",
                            "content": "one",
                        },
                    },
                )
                legacy = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "send-legacy",
                        "method": "channels.send",
                        "params": {
                            "channel_id": "wire",
                            "conversation_id": "snake",
                            "content": "two",
                        },
                    },
                )
                listed = await _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "channel-list",
                        "method": "channels.list",
                        "params": {},
                    },
                )

                assert canonical["payload"] == {
                    "sent": True,
                    "channelId": "wire",
                    "conversationId": "camel",
                }
                assert legacy["payload"] == {
                    "sent": True,
                    "channelId": "wire",
                    "conversationId": "snake",
                }
                assert channels.sent == [
                    ("wire", "camel", "one"),
                    ("wire", "snake", "two"),
                ]
                assert listed["payload"] == [
                    {
                        "id": "wire",
                        "type": "webhook",
                        "connected": True,
                        "configured": True,
                        "running": True,
                        "messageCount": 7,
                    }
                ]
                assert "message_count" not in listed["payload"][0]
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Bounded output size ──────────────────────────────────────────────────


def test_output_size_bound():
    async def body():
        server = await _start_server(max_output_bytes=100)

        async def huge_handler(params, info):
            return {"data": "x" * 10_000}

        server.register_method("huge", huge_handler)

        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(ws, {"type": "req", "id": "huge-1", "method": "huge", "params": {}})
                assert res["ok"] is False
                assert res["error"]["code"] == RPC_ERROR["OUTPUT_TOO_LARGE"]
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_non_json_results_are_normalized_or_stably_rejected_without_closing_ws():
    async def body():
        server = await _start_server()

        async def normalizable_handler(params, info):
            return {
                "values": {1, 2},
                "path": Path("safe/path"),
                "blob": b"ok",
            }

        async def cyclic_handler(params, info):
            value = []
            value.append(value)
            return value

        server.register_method("normalizable", normalizable_handler)
        server.register_method("cyclic", cyclic_handler)

        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                normalized = await _rpc(
                    ws,
                    {"type": "req", "id": "json-1", "method": "normalizable", "params": {}},
                )
                assert normalized["ok"] is True
                assert set(normalized["payload"]["values"]) == {1, 2}
                assert normalized["payload"]["path"] == "safe/path"
                assert normalized["payload"]["blob"] == "ok"

                rejected = await _rpc(
                    ws,
                    {"type": "req", "id": "json-2", "method": "cyclic", "params": {}},
                )
                assert rejected["ok"] is False
                assert rejected["error"] == {
                    "code": RPC_ERROR["INTERNAL_ERROR"],
                    "message": "Method result is not JSON serializable",
                }

                ping = await _rpc(
                    ws,
                    {"type": "req", "id": "json-3", "method": "ping", "params": {}},
                )
                assert ping["ok"] is True
                assert ws.closed is False
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Errors never expose credentials ─────────────────────────────────────


def test_internal_error_scrubs_token():
    async def body():
        registry = FakeRegistry({"Boom": FakeAgent(name="Boom", raise_error=True)})
        server = await _start_server(agent_registry=registry)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(
                    ws, {"type": "req", "id": "boom-1", "method": "agents.execute", "params": {"name": "Boom"}}
                )
                assert res["ok"] is False
                assert TEST_TOKEN not in json.dumps(res)
                await ws.close()
        finally:
            await server.stop()

    run(body())


# ── Clean shutdown ───────────────────────────────────────────────────────


def test_clean_shutdown_closes_connections_and_stops_listening():
    async def body():
        server = await _start_server()
        host, port = server.host, server.port

        async with aiohttp.ClientSession() as session:
            ws = await _connect_ws(server, session)
            await _handshake(ws)

            await server.stop()

            assert server.running is False
            msg = await asyncio.wait_for(ws.receive(), timeout=5)
            assert msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED)

            # The listening socket is gone — a fresh connection attempt must fail.
            with pytest.raises(aiohttp.ClientConnectionError):
                async with session.get(f"http://{host}:{port}/health") as resp:
                    await resp.text()

    run(body())


def test_stop_is_bounded_with_a_truly_hung_sync_agent_and_workers_are_daemon():
    async def body():
        agent = HungAgent()
        server = await _start_server(
            agent_registry=FakeRegistry({"HungAgent": agent}),
            execution_timeout=60.0,
            max_agent_workers=1,
            shutdown_timeout=0.25,
        )
        async with aiohttp.ClientSession() as session:
            ws = await _connect_ws(server, session)
            await _handshake(ws)
            rpc_task = asyncio.create_task(
                _rpc(
                    ws,
                    {
                        "type": "req",
                        "id": "hung-1",
                        "method": "agents.execute",
                        "params": {"name": "HungAgent"},
                    },
                    timeout=2,
                )
            )
            for _ in range(100):
                if agent.entered.is_set():
                    break
                await asyncio.sleep(0.005)
            assert agent.entered.is_set()

            started = time.monotonic()
            await server.stop()
            elapsed = time.monotonic() - started
            assert elapsed < 0.5
            assert server.running is False
            assert server._worker_pool.in_flight == 1
            workers = server._worker_pool.threads
            assert workers
            assert all(worker.daemon for worker in workers)
            assert not any(
                worker.name.startswith("openrappter-sync") and not worker.daemon
                for worker in threading.enumerate()
            )
            await asyncio.gather(rpc_task, return_exceptions=True)

            server.execution_timeout = 0.05
            await server.start()
            try:
                restarted_ws = await _connect_ws(server, session)
                await _handshake(restarted_ws, frame_id="hung-restart-connect")
                ping = await _rpc(
                    restarted_ws,
                    {
                        "type": "req",
                        "id": "hung-restart-ping",
                        "method": "ping",
                        "params": {},
                    },
                )
                blocked = await _rpc(
                    restarted_ws,
                    {
                        "type": "req",
                        "id": "hung-restart-agent",
                        "method": "agents.execute",
                        "params": {"name": "HungAgent"},
                    },
                )
                assert ping["ok"] is True
                assert blocked["error"]["code"] == RPC_ERROR["TIMEOUT"]
                assert server._worker_pool.in_flight == 1
                assert server._worker_pool.threads == workers
                await restarted_ws.close()
            finally:
                await server.stop()

    run(body())


def test_start_stop_start_is_idempotent_and_reusable():
    async def body():
        server = GatewayServer(host="127.0.0.1", port=0, token=TEST_TOKEN)
        await server.start()
        await server.start()  # idempotent — no error, no duplicate listeners
        await server.stop()
        await server.stop()  # idempotent

        # Server is reusable after a clean stop.
        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/health") as resp:
                    assert resp.status == 200
        finally:
            await server.stop()

    run(body())


def test_concurrent_start_stop_calls_are_serialized_and_restartable():
    async def body():
        server = GatewayServer(host="127.0.0.1", port=0, token=TEST_TOKEN)

        await asyncio.gather(*(server.start() for _ in range(12)))
        assert server.running is True
        async with aiohttp.ClientSession() as session:
            async with session.get(f"http://{server.host}:{server.port}/health") as resp:
                assert resp.status == 200

        await asyncio.gather(*(server.stop() for _ in range(12)))
        assert server.running is False
        assert server._runner is None
        assert server._site is None

        await server.start()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    assert resp.status == 200
        finally:
            await server.stop()

    run(body())


def test_stop_during_start_cleans_the_completed_listener_without_state_race():
    async def body():
        server = GatewayServer(host="127.0.0.1", port=0, token=TEST_TOKEN)
        start_entered = asyncio.Event()
        allow_start = asyncio.Event()
        original_start = web.TCPSite.start

        async def delayed_start(site):
            start_entered.set()
            await allow_start.wait()
            await original_start(site)

        with patch.object(web.TCPSite, "start", delayed_start):
            start_task = asyncio.create_task(server.start())
            await asyncio.wait_for(start_entered.wait(), timeout=0.2)
            stop_task = asyncio.create_task(server.stop())
            await asyncio.sleep(0)
            assert stop_task.done() is False
            allow_start.set()
            await asyncio.wait_for(
                asyncio.gather(start_task, stop_task),
                timeout=0.5,
            )

        assert server.running is False
        assert server._runner is None
        assert server._site is None
        assert server._app is None
        assert server._agent_executor is None

        # The same instance remains reusable after the raced lifecycle.
        await server.start()
        await server.stop()

    run(body())


def test_stop_wakes_run_forever_and_removes_signal_handlers():
    async def body():
        server = GatewayServer(host="127.0.0.1", port=0, token=TEST_TOKEN)
        loop = asyncio.get_running_loop()
        installed = []
        removed = []

        with (
            patch.object(
                loop,
                "add_signal_handler",
                side_effect=lambda sig, callback: installed.append(sig),
            ),
            patch.object(
                loop,
                "remove_signal_handler",
                side_effect=lambda sig: removed.append(sig) or True,
            ),
        ):
            run_task = asyncio.create_task(server.run_forever())
            for _ in range(100):
                if server.running:
                    break
                await asyncio.sleep(0)
            assert server.running is True

            await server.stop()
            await asyncio.wait_for(run_task, timeout=0.5)

        assert installed == [signal.SIGINT, signal.SIGTERM]
        assert removed == installed
        assert server.running is False

    run(body())
