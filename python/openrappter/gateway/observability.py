"""
Gateway observability: bounded in-memory counters and centralized
structured logging for the async HTTP/WebSocket gateway.

Mirrors ``typescript/src/gateway/observability.ts``:

  - Low-cardinality, credential-free metrics snapshot suitable for
    exposing via ``/status``, ``/health``, and the canonical
    ``status``/``health`` RPC methods without breaking their existing
    fields.
  - Counters live for exactly one ``GatewayServer`` instance and reset
    predictably: a new instance starts at zero, and ``reset()`` re-arms an
    existing instance (used by tests and instance recycling). They are
    never persisted to disk.
  - Structured JSON logging is strictly opt-in via
    ``OPENRAPPTER_LOG_FORMAT=json`` so default output stays
    human-readable and free of per-request noise.
  - Never log method names, user input, tokens, passwords, or stack
    traces — only bounded, low-cardinality fields (counts, durations,
    enums).
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from typing import Any, Dict, Optional

# Mutually-exclusive classification of a single RPC dispatch attempt.
RPC_OUTCOMES = ("success", "error", "auth_failure", "rate_limited", "timeout")


class GatewayMetrics:
    """Bounded in-memory counters for one gateway server instance.

    Every counter is a plain int (no unbounded maps/labels), so memory use
    never grows with request volume. ``/health`` and ``/status`` polling
    never touches this class — only the WS RPC dispatch path calls
    ``record_request()``.
    """

    def __init__(self, agent_worker_capacity: int = 0) -> None:
        self._lock = threading.RLock()
        self._agent_worker_capacity = agent_worker_capacity
        self._rpc_requests_total = 0
        self._rpc_success_total = 0
        self._rpc_errors_total = 0
        self._rpc_auth_failures_total = 0
        self._rpc_rate_limited_total = 0
        self._rpc_timeouts_total = 0
        self._active_agent_executions = 0
        self._agent_workers_in_use = 0
        self._started_at: Optional[float] = None

    def start(self) -> None:
        """Mark the metrics window as started. Resets every counter/gauge to
        zero first — this is the predictable "reset per server instance/start"
        boundary so restarting the same ``GatewayServer`` instance behaves
        identically to a fresh one."""
        with self._lock:
            self.reset()
            self._started_at = time.time()

    def stop(self) -> None:
        """Mark the metrics window as stopped (uptime reports 0 until the next start)."""
        with self._lock:
            self._started_at = None

    def reset(self) -> None:
        """Reset every counter/gauge to zero. Predictable boundary for tests/recycling."""
        with self._lock:
            self._rpc_requests_total = 0
            self._rpc_success_total = 0
            self._rpc_errors_total = 0
            self._rpc_auth_failures_total = 0
            self._rpc_rate_limited_total = 0
            self._rpc_timeouts_total = 0
            self._active_agent_executions = 0
            self._agent_workers_in_use = 0
            self._started_at = None

    def record_request(self, outcome: str) -> None:
        """Record exactly one RPC dispatch outcome. Never call for ``/health``/``/status`` polling."""
        if outcome not in RPC_OUTCOMES:
            raise ValueError(f"Unknown RPC outcome: {outcome!r}")
        with self._lock:
            self._rpc_requests_total += 1
            if outcome == "success":
                self._rpc_success_total += 1
            elif outcome == "error":
                self._rpc_errors_total += 1
            elif outcome == "auth_failure":
                self._rpc_auth_failures_total += 1
            elif outcome == "rate_limited":
                self._rpc_rate_limited_total += 1
            elif outcome == "timeout":
                self._rpc_timeouts_total += 1

    def agent_execution_started(self) -> None:
        """Gauge: an agent execution began (``agents.execute`` or equivalent)."""
        with self._lock:
            self._active_agent_executions += 1

    def agent_execution_finished(self) -> None:
        """Gauge: an agent execution finished (success or failure). Never goes negative."""
        with self._lock:
            if self._active_agent_executions > 0:
                self._active_agent_executions -= 1

    def agent_worker_acquired(self) -> None:
        """Gauge: a dedicated agent-execution thread pool slot was acquired."""
        with self._lock:
            self._agent_workers_in_use += 1

    def agent_worker_released(self) -> None:
        """Gauge: a dedicated agent-execution thread pool slot was released. Never goes negative."""
        with self._lock:
            if self._agent_workers_in_use > 0:
                self._agent_workers_in_use -= 1

    @property
    def agent_worker_capacity(self) -> int:
        """Python runtime detail, intentionally excluded from the wire DTO."""
        with self._lock:
            return self._agent_worker_capacity

    @property
    def agent_workers_in_use(self) -> int:
        """Python runtime detail, intentionally excluded from the wire DTO."""
        with self._lock:
            return self._agent_workers_in_use

    def snapshot(self, active_connections: int) -> Dict[str, Any]:
        """Canonical TypeScript/Swift wire snapshot."""
        with self._lock:
            return {
                "rpcRequestsTotal": self._rpc_requests_total,
                "rpcSuccessTotal": self._rpc_success_total,
                "rpcErrorsTotal": self._rpc_errors_total,
                "rpcAuthFailuresTotal": self._rpc_auth_failures_total,
                "rpcRateLimitedTotal": self._rpc_rate_limited_total,
                "rpcTimeoutsTotal": self._rpc_timeouts_total,
                "activeConnections": active_connections,
                "activeAgentExecutions": self._active_agent_executions,
                "uptimeSeconds": int(time.time() - self._started_at) if self._started_at else 0,
            }


# ── Structured logging ───────────────────────────────────────────────────

_SECRET_KEY_PATTERN = re.compile(r"token|password|secret|credential|authorization", re.IGNORECASE)


def _is_json_log_format() -> bool:
    return os.environ.get("OPENRAPPTER_LOG_FORMAT", "").strip().lower() == "json"


def _redact_fields(fields: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Strip anything that looks like a secret. Defense in depth: callers must
    only ever pass safe numeric/enum fields, but this guarantees a
    mislabeled field can't leak a credential into logs."""
    safe: Dict[str, Any] = {}
    if not fields:
        return safe
    for key, value in fields.items():
        if value is None:
            continue
        safe[key] = "[REDACTED]" if _SECRET_KEY_PATTERN.search(key) else value
    return safe


def _emit(level: str, human_message: str, payload: Dict[str, Any]) -> None:
    """Write directly to stdout/stderr, deliberately bypassing the
    application's global `logging` configuration (and whatever handler/
    formatter it has installed) so a JSON line is always exactly
    parseable — never wrapped in an unrelated `"INFO: "`-style prefix.
    Mirrors `console.log`/`console.error` in the TypeScript gateway.
    """
    line = json.dumps(payload) if _is_json_log_format() else human_message
    stream = sys.stderr if level == "error" else sys.stdout
    print(line, file=stream)


def log_gateway_lifecycle(
    component: str,
    event: str,
    message: str,
    fields: Optional[Dict[str, Any]] = None,
    level: str = "info",
) -> None:
    """Log a gateway lifecycle event (start/stop/listener error). Always
    emitted — as a plain human message by default, or as a structured
    ``{timestamp, level, component, event, ...fields}`` JSON record when
    ``OPENRAPPTER_LOG_FORMAT=json`` is set."""
    _emit(
        level,
        message,
        {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level,
            "component": component,
            "event": event,
            **_redact_fields(fields),
        },
    )


def log_gateway_request(
    component: str,
    event: str,
    fields: Optional[Dict[str, Any]] = None,
    level: str = "info",
) -> None:
    """Log a per-request gateway event. Only emitted when
    ``OPENRAPPTER_LOG_FORMAT=json`` is set, keeping default operation free
    of per-request console noise. ``fields`` must only ever contain
    bounded, low-cardinality values (outcome enums, durations, counts) —
    never method names, user input, tokens, or stack traces."""
    if not _is_json_log_format():
        return
    _emit(
        level,
        "",
        {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "level": level,
            "component": component,
            "event": event,
            **_redact_fields(fields),
        },
    )
