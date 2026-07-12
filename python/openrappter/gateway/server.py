"""
GatewayServer — async HTTP + WebSocket transport for the Python runtime.

Mirrors the wire protocol implemented by the TypeScript gateway
(`typescript/src/gateway/server.ts`):

  - WebSocket frames: ``{"type": "req", "id", "method", "params"}`` ->
    ``{"type": "res", "id", "ok", "payload"|"error"}``
  - HTTP ``GET /health`` and ``GET /status`` for liveness/readiness checks
  - A mandatory ``connect`` handshake before any other RPC is accepted
  - Token-based auth with constant-time comparison, with an auth-disabled
    mode permitted only when bound to a loopback interface

Built on `aiohttp` (a single, actively-maintained dependency that provides
both the HTTP server and WebSocket support) instead of hand-rolled framing
over raw sockets — this keeps the transport layer small and lets the async
loop, header parsing, and WebSocket control-frame handling (ping/pong,
close codes, max-message-size enforcement) be handled by a well-tested
library rather than bespoke code.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import signal
import time
import uuid
from concurrent.futures import Future as ConcurrentFuture
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional, Tuple
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType

from openrappter._bounded_workers import (
    BoundedDaemonExecutor,
    WorkerCapacityError,
    wait_for_worker,
)
from openrappter.gateway.observability import GatewayMetrics, log_gateway_lifecycle, log_gateway_request

logger = logging.getLogger(__name__)

# Stable RPC error codes (mirrors typescript/src/gateway/types.ts RPC_ERROR,
# extended with transport-level bounds not present upstream).
RPC_ERROR: Dict[str, int] = {
    "PARSE_ERROR": -32700,
    "INVALID_REQUEST": -32600,
    "METHOD_NOT_FOUND": -32601,
    "INVALID_PARAMS": -32602,
    "INTERNAL_ERROR": -32603,
    "UNAUTHORIZED": -32000,
    "RATE_LIMITED": -32001,
    "TIMEOUT": -32002,
    "PAYLOAD_TOO_LARGE": -32003,
    "OUTPUT_TOO_LARGE": -32004,
}

PROTOCOL_VERSION = 3
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
WILDCARD_HOSTS = {"0.0.0.0", "::"}
_HOSTNAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$")
_MAX_HOST_HEADER_BYTES = 255
_MAX_ORIGIN_HEADER_BYTES = 2048

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18790
DEFAULT_MAX_MESSAGE_BYTES = 1_000_000       # inbound WS frame cap
DEFAULT_MAX_OUTPUT_BYTES = 1_000_000        # outbound result payload cap
DEFAULT_EXECUTION_TIMEOUT = 30.0            # seconds per RPC call
DEFAULT_RATE_LIMIT_MAX = 100                # requests per window per connection
DEFAULT_RATE_LIMIT_WINDOW = 60.0            # seconds
DEFAULT_MAX_AGENT_WORKERS = 4
DEFAULT_SHUTDOWN_TIMEOUT = 2.0

_Origin = Tuple[str, str, int]


def safe_compare(a: str, b: str) -> bool:
    """Constant-time comparison of two secrets.

    Both inputs are hashed to fixed-length digests before comparison so
    that neither the differing lengths of the raw strings nor any
    early-exit behavior can leak timing information about the secret
    (mirrors ``safeCompare`` in ``typescript/src/gateway/server.ts``).
    """
    digest_a = hashlib.sha256(a.encode("utf-8")).digest()
    digest_b = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(digest_a, digest_b)


def _iso_timestamp(timestamp: Optional[float] = None) -> str:
    value = time.time() if timestamp is None else timestamp
    return (
        datetime.fromtimestamp(value, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _normalize_hostname(hostname: str) -> Optional[str]:
    value = hostname.lower()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        if not _HOSTNAME_PATTERN.fullmatch(value) or ".." in value:
            return None
        return value


def _parse_origin(value: str, *, allow_trailing_slash: bool = False) -> Optional[_Origin]:
    if (
        not value
        or len(value) > _MAX_ORIGIN_HEADER_BYTES
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
    ):
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or (
            parsed.path
            and not (allow_trailing_slash and parsed.path == "/")
        )
    ):
        return None
    hostname = _normalize_hostname(parsed.hostname)
    if hostname is None:
        return None
    return parsed.scheme, hostname, port or (443 if parsed.scheme == "https" else 80)


def _parse_host_header(value: str, scheme: str) -> Optional[Tuple[str, int]]:
    if (
        not value
        or len(value) > _MAX_HOST_HEADER_BYTES
        or any(ord(char) <= 32 or ord(char) == 127 for char in value)
    ):
        return None
    try:
        parsed = urlsplit(f"{scheme}://{value}")
        port = parsed.port
    except ValueError:
        return None
    if (
        not parsed.netloc
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return None
    hostname = _normalize_hostname(parsed.hostname)
    if hostname is None:
        return None
    return hostname, port or (443 if scheme == "https" else 80)


@dataclass
class ConnectionInfo:
    """Per-connection state. `authenticated` starts False until `connect` succeeds."""

    id: str
    authenticated: bool = False
    connected_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class _RateLimitEntry:
    count: int = 0
    window_start: float = field(default_factory=time.time)


class GatewayError(Exception):
    """An RPC error carrying a stable error code, safe to surface to clients."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


MethodHandler = Callable[[Dict[str, Any], ConnectionInfo], Awaitable[Any]]


class GatewayServer:
    """Bounded async HTTP + WebSocket gateway for the Python runtime.

    Parameters
    ----------
    agent_registry:
        Any object exposing ``get_agent(name)`` and ``list_agents()``
        (the contract implemented by ``openrappter.cli.AgentRegistry``).
        Used to back the ``agents.list`` / ``agents.execute`` built-ins.
    host, port:
        Single configurable bind address. Auth-disabled mode (no token)
        is only permitted when `host` is a loopback address — binding to
        a non-loopback host without a token raises ``ValueError``.
    token:
        Shared secret required by the `connect` handshake when set.
        Compared using a constant-time comparison.
    trusted_origins:
        Exact HTTP(S) browser origins permitted to connect cross-origin.
        Requires token authentication. Originless native clients and exact
        same-origin browser clients do not need an entry.
    """

    def __init__(
        self,
        agent_registry: Any = None,
        channel_registry: Any = None,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        token: Optional[str] = None,
        max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES,
        max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
        execution_timeout: float = DEFAULT_EXECUTION_TIMEOUT,
        rate_limit_max: int = DEFAULT_RATE_LIMIT_MAX,
        rate_limit_window: float = DEFAULT_RATE_LIMIT_WINDOW,
        max_agent_workers: int = DEFAULT_MAX_AGENT_WORKERS,
        shutdown_timeout: float = DEFAULT_SHUTDOWN_TIMEOUT,
        version: str = "unknown",
        trusted_origins: Optional[Iterable[str]] = None,
    ) -> None:
        if not token and host not in LOOPBACK_HOSTS:
            raise ValueError(
                f"Gateway auth token is required when binding to a non-loopback host ({host!r}); "
                "auth-disabled mode is only permitted on loopback interfaces."
            )

        self.agent_registry = agent_registry
        # Any object exposing the openrappter.channels.ChannelRegistry
        # contract (get/list/get_status_list/send_message). Optional —
        # channels.* methods degrade gracefully (empty list / explicit
        # errors) when not configured, mirroring agent_registry=None.
        self.channel_registry = channel_registry
        self.host = host
        self.port = port
        self._bind_port = port
        self._token = token or None
        self.auth_enabled = bool(self._token)
        configured_origins = (
            [trusted_origins]
            if isinstance(trusted_origins, str)
            else list(trusted_origins or ())
        )
        if configured_origins and not self.auth_enabled:
            raise ValueError("trusted_origins requires gateway token authentication")
        self._trusted_origins: set[_Origin] = set()
        for origin in configured_origins:
            if not isinstance(origin, str):
                raise ValueError("trusted_origins entries must be strings")
            parsed_origin = _parse_origin(origin, allow_trailing_slash=True)
            if parsed_origin is None:
                raise ValueError(f"Invalid trusted WebSocket origin: {origin!r}")
            self._trusted_origins.add(parsed_origin)
        self.max_message_bytes = max_message_bytes
        self.max_output_bytes = max_output_bytes
        self.execution_timeout = execution_timeout
        self.rate_limit_max = rate_limit_max
        self.rate_limit_window = rate_limit_window
        if max_agent_workers < 1:
            raise ValueError("max_agent_workers must be at least 1")
        if shutdown_timeout <= 0:
            raise ValueError("shutdown_timeout must be positive")
        self.max_agent_workers = max_agent_workers
        self.shutdown_timeout = shutdown_timeout
        self.version = version

        self._app: Optional[web.Application] = None
        self._runner: Optional[web.AppRunner] = None
        self._site: Optional[web.TCPSite] = None
        self._started_at: Optional[float] = None
        self._connections: Dict[str, ConnectionInfo] = {}
        self._sockets: Dict[str, web.WebSocketResponse] = {}
        self._ws_tasks: set["asyncio.Task[Any]"] = set()
        self._rate_limits: Dict[str, _RateLimitEntry] = {}
        self._methods: Dict[str, Dict[str, Any]] = {}
        self._worker_pool = BoundedDaemonExecutor(
            max_workers=self.max_agent_workers,
            thread_name_prefix="openrappter-sync",
        )
        self._agent_executor: Optional[BoundedDaemonExecutor] = None
        self._lifecycle_lock = asyncio.Lock()
        self._run_stop_event = asyncio.Event()
        self._lifecycle_state = "stopped"
        self._lifecycle_generation = 0
        self.metrics = GatewayMetrics(agent_worker_capacity=self.max_agent_workers)

        self._register_builtin_methods()

    # ── Public API ─────────────────────────────────────────────────────

    def register_method(
        self, name: str, handler: MethodHandler, requires_auth: bool = False
    ) -> None:
        """Register an RPC method. `requires_auth` fails closed even if the
        connect-handshake gate is ever bypassed."""
        self._methods[name] = {"handler": handler, "requires_auth": requires_auth}

    @property
    def running(self) -> bool:
        return self._lifecycle_state == "running" and self._site is not None

    @property
    def connection_count(self) -> int:
        return len(self._connections)

    def get_status(self) -> Dict[str, Any]:
        return {
            "running": self.running,
            "port": self.port,
            "connections": len(self._connections),
            "uptime": int(time.time() - self._started_at) if self._started_at else 0,
            "version": self.version,
            "startedAt": _iso_timestamp(self._started_at) if self._started_at else "",
            "metrics": self.metrics.snapshot(len(self._connections)),
        }

    def get_health(self) -> Dict[str, Any]:
        return {
            "status": "ok" if self.running else "error",
            "version": self.version,
            "uptime": int(time.time() - self._started_at) if self._started_at else 0,
            "timestamp": _iso_timestamp(),
            "checks": {
                "gateway": self.running,
                "agents": self.agent_registry is not None,
            },
            "metrics": self.metrics.snapshot(len(self._connections)),
        }

    async def start(self) -> None:
        """Start the HTTP + WebSocket server. Idempotent."""
        async with self._lifecycle_lock:
            if self.running:
                return

            self._lifecycle_state = "starting"
            self._run_stop_event.clear()
            app = web.Application(client_max_size=self.max_message_bytes + 4096)
            app.router.add_get("/health", self._handle_health)
            app.router.add_get("/status", self._handle_status)
            app.router.add_get("/ws", self._handle_ws)
            app.router.add_get("/", self._handle_ws)
            runner = web.AppRunner(app, access_log=None)
            site: Optional[web.TCPSite] = None

            try:
                await runner.setup()
                site = web.TCPSite(runner, self.host, self._bind_port)
                await site.start()
            except BaseException:
                if site is not None:
                    try:
                        await site.stop()
                    except Exception:  # noqa: BLE001 — preserve start error
                        pass
                try:
                    await runner.cleanup()
                except Exception:  # noqa: BLE001 — preserve start error
                    pass
                self._worker_pool.cancel_pending()
                self._lifecycle_state = "stopped"
                self.metrics.stop()
                raise

            self._app = app
            self._runner = runner
            self._site = site
            self._agent_executor = self._worker_pool
            self._lifecycle_generation += 1

            if self._bind_port == 0:
                addresses = runner.addresses
                if addresses:
                    self.port = addresses[0][1]

            self._started_at = time.time()
            self.metrics.start()
            self._lifecycle_state = "running"
            log_gateway_lifecycle(
                "gateway", "start", f"Gateway server started on {self.host}:{self.port}",
                {"host": self.host, "port": self.port},
            )

    async def stop(self) -> None:
        """Stop the server, closing all open connections. Idempotent."""
        # Wake run_forever immediately, including while this call waits for
        # an in-progress start() to release the lifecycle lock.
        self._run_stop_event.set()
        async with self._lifecycle_lock:
            if self._lifecycle_state == "stopped" and self._runner is None:
                return

            self._lifecycle_state = "stopping"
            runner = self._runner
            site = self._site
            cleanup_error: Optional[BaseException] = None

            try:
                if site is not None:
                    await site.stop()

                for ws in list(self._sockets.values()):
                    if not ws.closed:
                        try:
                            await ws.close(code=1000, message=b"Server shutting down")
                        except Exception:  # noqa: BLE001 — best-effort shutdown
                            pass

                current_task = asyncio.current_task()
                ws_tasks = [
                    task
                    for task in self._ws_tasks
                    if task is not current_task and not task.done()
                ]
                for task in ws_tasks:
                    task.cancel()
                if ws_tasks:
                    await asyncio.gather(*ws_tasks, return_exceptions=True)

                self._worker_pool.cancel_pending()
                if runner is not None:
                    await asyncio.wait_for(
                        runner.cleanup(),
                        timeout=self.shutdown_timeout,
                    )
            except BaseException as exc:  # leave the instance restartable
                cleanup_error = exc
            finally:
                self._sockets.clear()
                self._connections.clear()
                self._rate_limits.clear()
                self._ws_tasks.clear()
                self._runner = None
                self._site = None
                self._app = None
                self._started_at = None
                self._agent_executor = None
                self.metrics.stop()
                self._lifecycle_state = "stopped"
                log_gateway_lifecycle("gateway", "stop", "Gateway server stopped")

            if cleanup_error is not None:
                raise cleanup_error

    async def run_forever(self) -> None:
        """Start the server and block until SIGINT/SIGTERM or `stop()`.

        Intended for foreground CLI use (`openrappter --gateway`).
        """
        await self.start()
        loop = asyncio.get_running_loop()

        def _request_stop() -> None:
            self._run_stop_event.set()

        installed_signals = []
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _request_stop)
                installed_signals.append(sig)
            except (NotImplementedError, RuntimeError):
                # Signal handlers unavailable (e.g. non-main thread, some
                # event loop policies) — KeyboardInterrupt still works.
                pass

        try:
            await self._run_stop_event.wait()
        finally:
            for sig in installed_signals:
                loop.remove_signal_handler(sig)
            await self.stop()

    # ── HTTP handlers ────────────────────────────────────────────────────

    async def _handle_health(self, request: web.Request) -> web.Response:
        health = self.get_health()
        status_code = 200 if health["status"] == "ok" else 503
        return web.json_response(health, status=status_code)

    async def _handle_status(self, request: web.Request) -> web.Response:
        return web.json_response(self.get_status())

    # ── WebSocket handling ───────────────────────────────────────────────

    async def _handle_ws(self, request: web.Request) -> web.StreamResponse:
        if not self._is_trusted_ws_source(request):
            return web.json_response(
                {"error": "Forbidden WebSocket request source"},
                status=403,
                headers={"Vary": "Origin"},
            )

        request_task = asyncio.current_task()
        if request_task is not None:
            self._ws_tasks.add(request_task)
        ws = web.WebSocketResponse(max_msg_size=self.max_message_bytes)
        await ws.prepare(request)

        conn_id = uuid.uuid4().hex
        info = ConnectionInfo(id=conn_id)
        self._connections[conn_id] = info
        self._sockets[conn_id] = ws

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._handle_message(conn_id, ws, info, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    logger.debug("WebSocket error for %s: %s", conn_id, ws.exception())
                    break
                elif msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.CLOSED):
                    break
        finally:
            self._connections.pop(conn_id, None)
            self._sockets.pop(conn_id, None)
            self._rate_limits.pop(conn_id, None)
            if request_task is not None:
                self._ws_tasks.discard(request_task)

        return ws

    def _is_trusted_ws_source(self, request: web.Request) -> bool:
        """Validate Host and browser Origin before the WebSocket upgrade."""
        host_headers = request.headers.getall("Host", [])
        if len(host_headers) != 1:
            return False

        scheme = "https" if request.secure else "http"
        authority = _parse_host_header(host_headers[0], scheme)
        if authority is None:
            return False
        request_host, request_port = authority

        allowed_hosts: set[str] = set()
        configured_host = _normalize_hostname(self.host.strip("[]"))
        if configured_host is not None and configured_host not in WILDCARD_HOSTS:
            allowed_hosts.add(configured_host)

        transport = request.transport
        socket_name = transport.get_extra_info("sockname") if transport is not None else None
        actual_port = self.port
        if isinstance(socket_name, tuple) and len(socket_name) >= 2:
            actual_host = _normalize_hostname(str(socket_name[0]).split("%", 1)[0])
            if actual_host is not None and actual_host not in WILDCARD_HOSTS:
                allowed_hosts.add(actual_host)
            if isinstance(socket_name[1], int):
                actual_port = socket_name[1]

        if allowed_hosts.intersection({"127.0.0.1", "::1"}):
            allowed_hosts.add("localhost")

        if request_host not in allowed_hosts or request_port != actual_port:
            return False

        origin_headers = request.headers.getall("Origin", [])
        if not origin_headers:
            return True
        if len(origin_headers) != 1:
            return False
        origin = _parse_origin(origin_headers[0])
        if origin is None:
            return False

        same_origin = origin == (scheme, request_host, request_port)
        if same_origin:
            return True
        return self.auth_enabled and origin in self._trusted_origins

    async def _handle_message(
        self, conn_id: str, ws: web.WebSocketResponse, info: ConnectionInfo, raw: str
    ) -> None:
        info.last_activity = time.time()

        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            await self._send_frame(
                ws, self._error_frame("", RPC_ERROR["PARSE_ERROR"], "Invalid JSON")
            )
            return

        frame = self._parse_frame(parsed)
        if frame is None:
            raw_id = parsed.get("id", "") if isinstance(parsed, dict) else ""
            await self._send_frame(
                ws,
                self._error_frame(
                    str(raw_id), RPC_ERROR["INVALID_REQUEST"], "Missing id or method"
                ),
            )
            return

        if not info.authenticated:
            if frame["method"] != "connect":
                await self._send_frame(
                    ws,
                    self._error_frame(
                        frame["id"],
                        RPC_ERROR["UNAUTHORIZED"],
                        "Handshake required: first message must be connect",
                    ),
                )
                return
            await self._handle_connect(conn_id, ws, info, frame)
            return

        await self._dispatch(conn_id, ws, info, frame)

    def _parse_frame(self, parsed: Any) -> Optional[Dict[str, Any]]:
        """Accept ``{type:'req', id, method, params}`` and bare ``{id, method, params}``."""
        if not isinstance(parsed, dict):
            return None
        raw_id = parsed.get("id")
        if isinstance(raw_id, str):
            frame_id = raw_id
        elif isinstance(raw_id, (int, float)) and not isinstance(raw_id, bool):
            frame_id = str(raw_id)
        else:
            return None
        method = parsed.get("method")
        if not isinstance(method, str) or not method:
            return None
        params = parsed.get("params")
        if not isinstance(params, dict):
            params = {}
        return {"id": frame_id, "method": method, "params": params}

    async def _handle_connect(
        self, conn_id: str, ws: web.WebSocketResponse, info: ConnectionInfo, frame: Dict[str, Any]
    ) -> None:
        params = frame["params"]

        if self.auth_enabled:
            auth = params.get("auth") if isinstance(params.get("auth"), dict) else {}
            token = auth.get("token")
            if not isinstance(token, str) or not token or not safe_compare(token, self._token):
                await self._send_frame(
                    ws,
                    self._error_frame(
                        frame["id"], RPC_ERROR["UNAUTHORIZED"], "Invalid or missing auth token"
                    ),
                )
                return

        info.authenticated = True
        client = params.get("client") if isinstance(params.get("client"), dict) else {}
        info.metadata["client"] = client

        payload = {
            "type": "hello-ok",
            "protocol": PROTOCOL_VERSION,
            "server": {"version": self.version, "host": self.host, "connId": conn_id},
            "features": {"methods": sorted(self._methods.keys())},
            "policy": {
                "maxMessageBytes": self.max_message_bytes,
                "maxOutputBytes": self.max_output_bytes,
                "executionTimeoutSeconds": self.execution_timeout,
            },
        }
        await self._send_frame(ws, {"type": "res", "id": frame["id"], "ok": True, "payload": payload})

    async def _dispatch(
        self, conn_id: str, ws: web.WebSocketResponse, info: ConnectionInfo, frame: Dict[str, Any]
    ) -> None:
        dispatch_started_at = time.time()

        def _finish(outcome: str) -> None:
            self.metrics.record_request(outcome)
            log_gateway_request(
                "gateway", "rpc.dispatch",
                {"transport": "ws", "outcome": outcome, "duration_ms": round((time.time() - dispatch_started_at) * 1000, 2)},
            )

        if not self._check_rate_limit(conn_id):
            _finish("rate_limited")
            await self._send_frame(
                ws, self._error_frame(frame["id"], RPC_ERROR["RATE_LIMITED"], "Rate limit exceeded")
            )
            return

        method = self._methods.get(frame["method"])
        if method is None:
            _finish("error")
            await self._send_frame(
                ws,
                self._error_frame(
                    frame["id"],
                    RPC_ERROR["METHOD_NOT_FOUND"],
                    f"Method '{frame['method']}' not found",
                ),
            )
            return

        if method["requires_auth"] and not info.authenticated:
            _finish("auth_failure")
            await self._send_frame(
                ws,
                self._error_frame(
                    frame["id"],
                    RPC_ERROR["UNAUTHORIZED"],
                    f"Method '{frame['method']}' requires authentication",
                ),
            )
            return

        try:
            result = await asyncio.wait_for(
                method["handler"](frame["params"], info), timeout=self.execution_timeout
            )
        except asyncio.TimeoutError:
            _finish("timeout")
            await self._send_frame(
                ws, self._error_frame(frame["id"], RPC_ERROR["TIMEOUT"], "Method execution timed out")
            )
            return
        except GatewayError as exc:
            _finish("error")
            await self._send_frame(ws, self._error_frame(frame["id"], exc.code, exc.message))
            return
        except Exception as exc:  # noqa: BLE001 — convert to a stable, credential-free error
            _finish("error")
            await self._send_frame(
                ws,
                self._error_frame(
                    frame["id"], RPC_ERROR["INTERNAL_ERROR"], self._safe_error_message(exc)
                ),
            )
            return

        try:
            encoded = json.dumps(
                result,
                default=self._json_fallback,
                ensure_ascii=False,
                allow_nan=False,
            )
            normalized_result = json.loads(encoded)
        except (TypeError, ValueError, OverflowError, RecursionError):
            _finish("error")
            await self._send_frame(
                ws,
                self._error_frame(
                    frame["id"],
                    RPC_ERROR["INTERNAL_ERROR"],
                    "Method result is not JSON serializable",
                ),
            )
            return

        if len(encoded.encode("utf-8")) > self.max_output_bytes:
            _finish("error")
            await self._send_frame(
                ws,
                self._error_frame(
                    frame["id"], RPC_ERROR["OUTPUT_TOO_LARGE"], "Result exceeds maximum output size"
                ),
            )
            return

        _finish("success")
        await self._send_frame(
            ws,
            {
                "type": "res",
                "id": frame["id"],
                "ok": True,
                "payload": normalized_result,
            },
        )

    @staticmethod
    def _json_fallback(value: Any) -> Any:
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, (bytes, bytearray, memoryview)):
            return bytes(value).decode("utf-8", errors="replace")
        if isinstance(value, (set, frozenset)):
            return list(value)
        raise TypeError(f"{value.__class__.__name__} is not JSON serializable")

    def _safe_error_message(self, exc: Exception) -> str:
        """Render an exception message, scrubbing the configured token if present."""
        message = str(exc) or exc.__class__.__name__
        if self._token:
            message = message.replace(self._token, "***")
        return message

    def _error_frame(self, frame_id: str, code: int, message: str) -> Dict[str, Any]:
        return {"type": "res", "id": frame_id, "ok": False, "error": {"code": code, "message": message}}

    async def _send_frame(self, ws: web.WebSocketResponse, frame: Dict[str, Any]) -> None:
        if ws.closed:
            return
        try:
            encoded = json.dumps(frame, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, OverflowError, RecursionError):
            frame_id = frame.get("id", "") if isinstance(frame, dict) else ""
            encoded = json.dumps(
                self._error_frame(
                    str(frame_id),
                    RPC_ERROR["INTERNAL_ERROR"],
                    "Response serialization failed",
                )
            )
        try:
            await ws.send_str(encoded)
        except (ConnectionResetError, RuntimeError):
            pass

    def _check_rate_limit(self, conn_id: str) -> bool:
        now = time.time()
        entry = self._rate_limits.get(conn_id)
        if entry is None or (now - entry.window_start) > self.rate_limit_window:
            self._rate_limits[conn_id] = _RateLimitEntry(count=1, window_start=now)
            return True
        if entry.count >= self.rate_limit_max:
            return False
        entry.count += 1
        return True

    # ── Built-in methods ─────────────────────────────────────────────────
    #
    # Cross-runtime contract note: `ping`/`status`/`health`/`agents.list`
    # are wire-compatible with the TypeScript gateway's canonical
    # registration path (see `typescript/src/gateway/methods/index.ts` and
    # `GatewayServer.registerBuiltInMethods` in
    # `typescript/src/gateway/server.ts`) — same names, same response
    # shapes, same fail-closed `requires_auth`/`requiresAuth` semantics.
    # This Python transport has no HTTP JSON-RPC POST surface (only
    # `/health`, `/status`, `/ws`), so the HTTP-auth-bypass class of bug
    # fixed on the TS side (forcing `authenticated: true` for HTTP RPC
    # dispatch) does not apply here. It also does not yet implement
    # `chat.*`/session methods, so the TS-side `sessionKey`/`sessionId`
    # alias has no Python counterpart to mirror yet.
    # `channels.list/connect/disconnect/probe/send` are now registered
    # with the same names and fail-closed auth semantics as
    # `typescript/src/gateway/server.ts` (`list`/`probe` open, `connect`/
    # `disconnect`/`send` require auth) but operate against
    # `openrappter.channels.ChannelRegistry` — the TS-side
    # `configureChannel`/`getChannelConfig` config-persistence methods have
    # no Python counterpart yet.
    # `agents.execute` is Python-only today; the TS canonical path does not
    # register it live (see the "canonical registration path" doc-comment
    # above `registerBuiltInMethods`) — do not assume parity for that name
    # until both sides register it identically.
    def _register_builtin_methods(self) -> None:
        self.register_method("ping", self._m_ping)
        self.register_method("status", self._m_status)
        self.register_method("health", self._m_health)
        self.register_method("agents.list", self._m_agents_list)
        self.register_method("agents.execute", self._m_agents_execute, requires_auth=True)
        self.register_method("channels.list", self._m_channels_list)
        self.register_method("channels.probe", self._m_channels_probe)
        self.register_method("channels.connect", self._m_channels_connect, requires_auth=True)
        self.register_method("channels.disconnect", self._m_channels_disconnect, requires_auth=True)
        self.register_method("channels.send", self._m_channels_send, requires_auth=True)

    async def _m_ping(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        return {"pong": int(time.time() * 1000)}

    async def _m_status(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        return self.get_status()

    async def _m_health(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        return self.get_health()

    async def _m_agents_list(self, params: Dict[str, Any], info: ConnectionInfo) -> Any:
        if self.agent_registry is None:
            return []
        return await self._run_sync(self.agent_registry.list_agents)

    async def _run_sync(
        self,
        function: Callable[[], Any],
        *,
        track_agent_worker: bool = False,
    ) -> Any:
        executor = self._agent_executor
        if executor is None:
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], "Sync worker pool is not running")

        work: Optional[ConcurrentFuture[Any]] = None
        while work is None:
            if self._agent_executor is not executor or self._lifecycle_state != "running":
                raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], "Sync worker pool is not running")
            try:
                work = executor.submit(function)
            except WorkerCapacityError:
                await asyncio.sleep(0.005)

        if track_agent_worker:
            generation = self._lifecycle_generation
            self.metrics.agent_worker_acquired()

            def release_worker(_future: ConcurrentFuture[Any]) -> None:
                if self._lifecycle_generation == generation:
                    self.metrics.agent_worker_released()

            work.add_done_callback(release_worker)

        return await wait_for_worker(work)

    async def _m_agents_execute(self, params: Dict[str, Any], info: ConnectionInfo) -> Any:
        name = params.get("name") or params.get("agent")
        if not isinstance(name, str) or not name:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], "'name' is required")
        if self.agent_registry is None:
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], "Agent registry not configured")

        agent = await self._run_sync(lambda: self.agent_registry.get_agent(name))
        if agent is None:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], f"Agent '{name}' not found")

        kwargs = params.get("kwargs")
        if not isinstance(kwargs, dict):
            kwargs = {}

        self.metrics.agent_execution_started()
        try:
            result_str = await self._run_sync(
                lambda: agent.execute(**kwargs),
                track_agent_worker=True,
            )

            if isinstance(result_str, str):
                try:
                    return json.loads(result_str)
                except json.JSONDecodeError:
                    return {"raw": result_str}
            return result_str
        finally:
            self.metrics.agent_execution_finished()

    # ── channels.* handlers ──────────────────────────────────────────────
    #
    # Backed by any object implementing the
    # `openrappter.channels.ChannelRegistry` contract. All registry/channel
    # calls use the same bounded daemon pool as agent execution, so a broken
    # synchronous extension cannot block the event loop or interpreter exit.

    @staticmethod
    def _channel_id_param(params: Dict[str, Any]) -> str:
        channel_id = (
            params.get("channelId")
            or params.get("channel_id")
            or params.get("type")
            or params.get("name")
        )
        if not isinstance(channel_id, str) or not channel_id:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], "'channelId' is required")
        return channel_id

    async def _get_channel_or_raise(self, channel_id: str) -> Any:
        if self.channel_registry is None:
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], "Channel registry not configured")
        channel = await self._run_sync(lambda: self.channel_registry.get(channel_id))
        if channel is None:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], f"Channel '{channel_id}' not found")
        return channel

    async def _m_channels_list(self, params: Dict[str, Any], info: ConnectionInfo) -> Any:
        if self.channel_registry is None:
            return []
        statuses = await self._run_sync(self.channel_registry.get_status_list)
        canonical = []
        for status in statuses:
            if not isinstance(status, dict):
                continue
            connected = bool(status.get("connected"))
            dto = {
                "id": status.get("id", ""),
                "type": status.get("type", ""),
                "connected": connected,
                "configured": bool(status.get("configured", True)),
                "running": bool(status.get("running", connected)),
                "messageCount": status.get(
                    "messageCount",
                    status.get("message_count", 0),
                ),
            }
            for canonical_key, legacy_key in (
                ("lastActivity", "last_activity"),
                ("lastConnectedAt", "last_connected_at"),
                ("lastError", "last_error"),
            ):
                value = status.get(canonical_key, status.get(legacy_key))
                if value is not None:
                    dto[canonical_key] = value
            canonical.append(dto)
        return canonical

    async def _m_channels_probe(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        channel_id = self._channel_id_param(params)
        if self.channel_registry is None:
            return {"ok": False, "error": "Channel registry not configured"}
        channel = await self._run_sync(lambda: self.channel_registry.get(channel_id))
        if channel is None:
            return {"ok": False, "error": f"Channel '{channel_id}' not registered"}
        return {"ok": bool(channel.connected), "error": None if channel.connected else "Not connected"}

    async def _m_channels_connect(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        channel_id = self._channel_id_param(params)
        channel = await self._get_channel_or_raise(channel_id)
        try:
            await self._run_sync(channel.connect)
        except GatewayError:
            raise
        except Exception as exc:  # noqa: BLE001 — normalized to a stable, credential-free error
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], self._safe_error_message(exc)) from exc
        return {"connected": True, "channelId": channel_id}

    async def _m_channels_disconnect(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        channel_id = self._channel_id_param(params)
        channel = await self._get_channel_or_raise(channel_id)
        try:
            await self._run_sync(channel.disconnect)
        except GatewayError:
            raise
        except Exception as exc:  # noqa: BLE001 — normalized to a stable, credential-free error
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], self._safe_error_message(exc)) from exc
        return {"disconnected": True, "channelId": channel_id}

    async def _m_channels_send(self, params: Dict[str, Any], info: ConnectionInfo) -> Dict[str, Any]:
        channel_id = self._channel_id_param(params)
        conversation_id = params.get("conversationId") or params.get("conversation_id")
        content = params.get("content")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], "'conversationId' is required")
        if not isinstance(content, str) or not content:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], "'content' is required")
        if self.channel_registry is None:
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], "Channel registry not configured")

        try:
            await self._run_sync(
                lambda: self.channel_registry.send_message(
                    channel_id,
                    conversation_id,
                    content,
                )
            )
        except ValueError as exc:
            raise GatewayError(RPC_ERROR["INVALID_PARAMS"], str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 — normalized to a stable, credential-free error
            raise GatewayError(RPC_ERROR["INTERNAL_ERROR"], self._safe_error_message(exc)) from exc

        return {
            "sent": True,
            "channelId": channel_id,
            "conversationId": conversation_id,
        }
