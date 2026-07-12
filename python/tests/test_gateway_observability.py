"""
Behavioral tests for openrappter.gateway observability (cycle-11: OPERABILITY).

Covers the bounded in-memory counters and structured logging added in
``openrappter/gateway/observability.py`` and wired into ``GatewayServer``:

  - RPC outcome counters (success/error/auth_failure/rate_limited/timeout)
    increment exactly once per WS dispatch attempt
  - ``/health`` and ``/status`` never count polling as an RPC request
  - Active connection and active agent execution gauges
  - Dedicated-agent worker capacity/in-use counts
  - Predictable reset semantics: a fresh instance, and restarting the same
    instance, both start at zero
  - Structured JSON logging opt-in via OPENRAPPTER_LOG_FORMAT=json, with
    credential redaction and no per-request noise by default

Mirrors the intent of
``typescript/src/__tests__/integration/gateway-observability.test.ts``.
"""

import asyncio
import json
import os
import threading

import aiohttp
import pytest

from openrappter.gateway import GatewayServer, RPC_ERROR
from openrappter.gateway.observability import GatewayMetrics, log_gateway_lifecycle, log_gateway_request

TEST_TOKEN = "test-token-abc123"


class FakeAgent:
    def __init__(self, name="EchoAgent"):
        self.name = name

    def execute(self, **kwargs):
        return json.dumps({"status": "success", "echo": kwargs})


class BlockingAgent:
    """An agent whose execute() blocks until `release` is set — lets tests
    observe the active-execution / worker-in-use gauges mid-flight."""

    def __init__(self):
        self.name = "BlockingAgent"
        self.started = threading.Event()
        self.release = threading.Event()

    def execute(self, **kwargs):
        self.started.set()
        self.release.wait(timeout=5)
        return json.dumps({"status": "success"})


class FakeRegistry:
    def __init__(self, agents=None):
        self._agents = agents or {"EchoAgent": FakeAgent()}

    def get_agent(self, name):
        return self._agents.get(name)

    def list_agents(self):
        return [{"name": name, "description": "fake"} for name in self._agents]


def run(coro):
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


# ── GatewayMetrics unit behavior ─────────────────────────────────────────


def test_fresh_metrics_instance_starts_at_zero():
    metrics = GatewayMetrics(agent_worker_capacity=4)
    snapshot = metrics.snapshot(active_connections=0)
    assert snapshot == {
        "rpcRequestsTotal": 0,
        "rpcSuccessTotal": 0,
        "rpcErrorsTotal": 0,
        "rpcAuthFailuresTotal": 0,
        "rpcRateLimitedTotal": 0,
        "rpcTimeoutsTotal": 0,
        "activeConnections": 0,
        "activeAgentExecutions": 0,
        "uptimeSeconds": 0,
    }


def test_record_request_increments_exactly_one_outcome_plus_total():
    metrics = GatewayMetrics()
    metrics.record_request("success")
    metrics.record_request("error")
    metrics.record_request("auth_failure")
    metrics.record_request("rate_limited")
    metrics.record_request("timeout")

    snapshot = metrics.snapshot(0)
    assert snapshot["rpcRequestsTotal"] == 5
    assert snapshot["rpcSuccessTotal"] == 1
    assert snapshot["rpcErrorsTotal"] == 1
    assert snapshot["rpcAuthFailuresTotal"] == 1
    assert snapshot["rpcRateLimitedTotal"] == 1
    assert snapshot["rpcTimeoutsTotal"] == 1


def test_record_request_rejects_unknown_outcome():
    metrics = GatewayMetrics()
    with pytest.raises(ValueError):
        metrics.record_request("bogus")


def test_active_agent_execution_gauge_never_goes_negative():
    metrics = GatewayMetrics()
    metrics.agent_execution_started()
    metrics.agent_execution_started()
    assert metrics.snapshot(0)["activeAgentExecutions"] == 2
    metrics.agent_execution_finished()
    assert metrics.snapshot(0)["activeAgentExecutions"] == 1
    metrics.agent_execution_finished()
    metrics.agent_execution_finished()  # extra finish must not go negative
    assert metrics.snapshot(0)["activeAgentExecutions"] == 0


def test_agent_worker_in_use_gauge_never_goes_negative():
    metrics = GatewayMetrics(agent_worker_capacity=2)
    metrics.agent_worker_acquired()
    assert metrics.agent_workers_in_use == 1
    assert metrics.agent_worker_capacity == 2
    metrics.agent_worker_released()
    metrics.agent_worker_released()
    assert metrics.agent_workers_in_use == 0


def test_start_resets_counters_and_stop_zeroes_uptime():
    metrics = GatewayMetrics()
    metrics.record_request("success")
    metrics.agent_execution_started()
    metrics.start()  # start() re-arms: resets counters, then sets uptime baseline
    snapshot = metrics.snapshot(0)
    assert snapshot["rpcRequestsTotal"] == 0
    assert snapshot["activeAgentExecutions"] == 0
    assert snapshot["uptimeSeconds"] >= 0
    metrics.stop()
    assert metrics.snapshot(0)["uptimeSeconds"] == 0


def test_reset_clears_every_counter_and_gauge():
    metrics = GatewayMetrics()
    metrics.record_request("success")
    metrics.record_request("error")
    metrics.agent_execution_started()
    metrics.agent_worker_acquired()
    metrics.start()
    metrics.reset()
    snapshot = metrics.snapshot(0)
    assert snapshot["rpcRequestsTotal"] == 0
    assert snapshot["activeAgentExecutions"] == 0
    assert metrics.agent_workers_in_use == 0
    assert snapshot["uptimeSeconds"] == 0


# ── Wired into GatewayServer ──────────────────────────────────────────────


def test_status_and_health_expose_zeroed_metrics_for_a_fresh_server():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                async with session.get(f"http://{server.host}:{server.port}/health") as resp:
                    health = await resp.json()

            assert status["metrics"]["rpcRequestsTotal"] == 0
            assert status["metrics"]["activeConnections"] == 0
            assert health["metrics"]["rpcRequestsTotal"] == 0
            assert "agentWorkers" not in status["metrics"]
        finally:
            await server.stop()

    run(body())


def test_health_and_status_polling_never_counts_as_rpc():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                for _ in range(5):
                    async with session.get(f"http://{server.host}:{server.port}/health"):
                        pass
                    async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                        status = await resp.json()

            assert status["metrics"]["rpcRequestsTotal"] == 0
        finally:
            await server.stop()

    run(body())


def test_success_counter_increments_exactly_once_per_ws_rpc():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                await _rpc(ws, {"type": "req", "id": "p1", "method": "ping", "params": {}})
                await _rpc(ws, {"type": "req", "id": "p2", "method": "ping", "params": {}})

                # HTTP /status reflects the two prior pings (connect is not
                # dispatched through _dispatch, so it isn't counted).
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["rpcRequestsTotal"] == 2
                assert status["metrics"]["rpcSuccessTotal"] == 2
                assert status["metrics"]["rpcErrorsTotal"] == 0
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_error_counter_increments_exactly_once_for_unknown_method():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                res = await _rpc(ws, {"type": "req", "id": "u1", "method": "nope.nope", "params": {}})
                assert res["ok"] is False

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["rpcErrorsTotal"] == 1
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_auth_failure_counter_increments_exactly_once():
    """`requires_auth` methods are already gated before `_dispatch` runs
    (an unauthenticated connection can only send `connect`), so this
    exercises `_dispatch`'s own fail-closed check directly — the same
    regression guard the TS gateway tests describe as protecting against
    a "dead requiresAuth flag" if the outer handshake gate is ever
    relaxed."""

    async def body():
        server = await _start_server()
        try:
            server.register_method("protected.thing", lambda p, i: asyncio.sleep(0, result={"ok": True}), requires_auth=True)

            from openrappter.gateway.server import ConnectionInfo

            unauth_info = ConnectionInfo(id="unauth-conn")
            assert unauth_info.authenticated is False

            class _FakeWs:
                def __init__(self):
                    self.sent = []
                    self.closed = False

                async def send_str(self, data):
                    self.sent.append(json.loads(data))

            fake_ws = _FakeWs()
            await server._dispatch(
                "unauth-conn", fake_ws, unauth_info,
                {"id": "prot-1", "method": "protected.thing", "params": {}},
            )
            assert fake_ws.sent[0]["ok"] is False
            assert fake_ws.sent[0]["error"]["code"] == RPC_ERROR["UNAUTHORIZED"]

            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
            assert status["metrics"]["rpcAuthFailuresTotal"] == 1
            assert status["metrics"]["rpcRequestsTotal"] == 1
        finally:
            await server.stop()

    run(body())


def test_rate_limit_counter_matches_rate_limited_responses():
    async def body():
        server = await _start_server(rate_limit_max=3, rate_limit_window=60.0)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                results = []
                for i in range(6):
                    res = await _rpc(ws, {"type": "req", "id": f"p{i}", "method": "ping", "params": {}})
                    results.append(res)
                rate_limited = [r for r in results if r["ok"] is False and r["error"]["code"] == RPC_ERROR["RATE_LIMITED"]]
                assert len(rate_limited) > 0

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["rpcRateLimitedTotal"] == len(rate_limited)
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_timeout_counter_increments_exactly_once():
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

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["rpcTimeoutsTotal"] == 1
                await ws.close()
        finally:
            await server.stop()

    run(body())


def test_active_connections_gauge_tracks_ws_connect_and_disconnect():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws1 = await _connect_ws(server, session)
                await _handshake(ws1, frame_id="c1")
                ws2 = await _connect_ws(server, session)
                await _handshake(ws2, frame_id="c2")

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["activeConnections"] == 2

                await ws1.close()
                await asyncio.sleep(0.2)

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["activeConnections"] == 1
                await ws2.close()
        finally:
            await server.stop()

    run(body())


def test_active_agent_executions_and_worker_in_use_gauges_track_a_blocking_agent():
    async def body():
        agent = BlockingAgent()
        registry = FakeRegistry({"BlockingAgent": agent})
        server = await _start_server(agent_registry=registry, max_agent_workers=2)
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)

                call_task = asyncio.create_task(
                    _rpc(ws, {"type": "req", "id": "exec-1", "method": "agents.execute", "params": {"name": "BlockingAgent"}}, timeout=10)
                )

                # Wait for the agent thread to actually start.
                for _ in range(50):
                    if agent.started.is_set():
                        break
                    await asyncio.sleep(0.05)
                assert agent.started.is_set()

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["activeAgentExecutions"] == 1
                assert server.metrics.agent_worker_capacity == 2
                assert server.metrics.agent_workers_in_use == 1

                agent.release.set()
                res = await call_task
                assert res["ok"] is True

                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    status = await resp.json()
                assert status["metrics"]["activeAgentExecutions"] == 0
                assert server.metrics.agent_workers_in_use == 0
                await ws.close()
        finally:
            agent.release.set()
            await server.stop()

    run(body())


def test_fresh_server_instance_starts_with_zeroed_counters():
    async def body():
        server1 = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server1, session)
                await _handshake(ws)
                await _rpc(ws, {"type": "req", "id": "p1", "method": "ping", "params": {}})
                async with session.get(f"http://{server1.host}:{server1.port}/status") as resp:
                    status1 = await resp.json()
                assert status1["metrics"]["rpcRequestsTotal"] > 0
                await ws.close()
        finally:
            await server1.stop()

        server2 = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server2.host}:{server2.port}/status") as resp:
                    status2 = await resp.json()
            assert status2["metrics"]["rpcRequestsTotal"] == 0
        finally:
            await server2.stop()

    run(body())


def test_restarting_the_same_instance_resets_counters_to_zero():
    async def body():
        server = await _start_server()
        try:
            async with aiohttp.ClientSession() as session:
                ws = await _connect_ws(server, session)
                await _handshake(ws)
                await _rpc(ws, {"type": "req", "id": "p1", "method": "ping", "params": {}})
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    before = await resp.json()
                assert before["metrics"]["rpcRequestsTotal"] > 0
                await ws.close()

            await server.stop()
            await server.start()

            async with aiohttp.ClientSession() as session:
                async with session.get(f"http://{server.host}:{server.port}/status") as resp:
                    after = await resp.json()
            assert after["metrics"]["rpcRequestsTotal"] == 0
            assert after["metrics"]["activeConnections"] == 0
        finally:
            await server.stop()

    run(body())


# ── Structured logging ────────────────────────────────────────────────────


def test_human_readable_by_default(capsys):
    if "OPENRAPPTER_LOG_FORMAT" in os.environ:
        del os.environ["OPENRAPPTER_LOG_FORMAT"]
    log_gateway_lifecycle("gateway", "start", "Gateway server started on 127.0.0.1:18790", {"port": 18790})
    captured = capsys.readouterr()
    assert captured.out.strip() == "Gateway server started on 127.0.0.1:18790"


def test_json_log_format_emits_parseable_line_with_required_fields(capsys):
    os.environ["OPENRAPPTER_LOG_FORMAT"] = "json"
    try:
        log_gateway_lifecycle("gateway", "start", "Gateway server started", {"port": 18790})
        captured = capsys.readouterr()
        parsed = json.loads(captured.out.strip())
        assert parsed["level"] == "info"
        assert parsed["component"] == "gateway"
        assert parsed["event"] == "start"
        assert isinstance(parsed["timestamp"], str)
        assert parsed["port"] == 18790
    finally:
        del os.environ["OPENRAPPTER_LOG_FORMAT"]


def test_json_log_format_redacts_secret_like_fields(capsys):
    os.environ["OPENRAPPTER_LOG_FORMAT"] = "json"
    try:
        log_gateway_lifecycle(
            "gateway", "start", "msg",
            {"token": "super-secret-value", "authorization": "Bearer abc", "safe_count": 3},
        )
        captured = capsys.readouterr()
        line = captured.out.strip()
        parsed = json.loads(line)
        assert parsed["token"] == "[REDACTED]"
        assert parsed["authorization"] == "[REDACTED]"
        assert parsed["safe_count"] == 3
        assert "super-secret-value" not in line
        assert "Bearer abc" not in line
    finally:
        del os.environ["OPENRAPPTER_LOG_FORMAT"]


def test_per_request_logs_suppressed_by_default(capsys):
    if "OPENRAPPTER_LOG_FORMAT" in os.environ:
        del os.environ["OPENRAPPTER_LOG_FORMAT"]
    log_gateway_request("gateway", "rpc.dispatch", {"transport": "ws", "outcome": "success", "duration_ms": 3})
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""


def test_per_request_logs_emitted_only_in_json_mode_without_method_names(capsys):
    os.environ["OPENRAPPTER_LOG_FORMAT"] = "json"
    try:
        log_gateway_request("gateway", "rpc.dispatch", {"transport": "ws", "outcome": "success", "duration_ms": 3})
        captured = capsys.readouterr()
        parsed = json.loads(captured.out.strip())
        assert parsed["transport"] == "ws"
        assert parsed["outcome"] == "success"
        assert parsed["duration_ms"] == 3
        assert "method" not in parsed
    finally:
        del os.environ["OPENRAPPTER_LOG_FORMAT"]
