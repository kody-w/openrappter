#!/usr/bin/env python3
"""CI-only E2E smoke test for the Python gateway's installed console script.

Deliberately black-box: it never imports ``openrappter`` directly (so it
validates the actual `pip install`-ed wheel and its ``openrappter`` console
entry point, not the repo's source tree via an editable install / PYTHONPATH
leak). Meant to run against a fresh venv that has only the built wheel
installed, e.g.:

    python -m venv /tmp-equivalent-venv-dir
    <venv>/bin/pip install dist/*.whl
    <venv>/bin/python python/scripts/gateway_token_smoke.py

Deterministic by construction:
  - binds an ephemeral port (ask the OS for a free one, then release it)
  - uses an isolated, throwaway HOME so no developer/CI-runner state
    (~/.openrappter/*) is read or written
  - the gateway subprocess is tracked by its exact PID and torn down with
    terminate()/kill() — never a name-based kill
  - polls with bounded retries/timeouts; never sleeps indefinitely

Verifies:
  - GET /health and GET /status report a running gateway with a version
  - a WebSocket connect with a *wrong* token is rejected (UNAUTHORIZED)
  - a WebSocket connect with the *correct* token succeeds and can execute
    the ``health`` RPC method
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

try:
    import aiohttp
    import asyncio
except ImportError as exc:  # pragma: no cover - fails loudly in CI logs
    print(f"FATAL: aiohttp is required (declared runtime dependency of the wheel): {exc}")
    sys.exit(2)

HEALTH_TIMEOUT_SECONDS = 20.0
HEALTH_POLL_INTERVAL_SECONDS = 0.25
WS_TIMEOUT_SECONDS = 10.0


def _free_tcp_port() -> int:
    """Ask the OS for a free ephemeral port, then release it immediately.

    Small inherent race (another process could grab it first) but is the
    standard, deterministic-enough approach for CI smoke tests binding to
    loopback only.
    """
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _find_openrappter_bin() -> str:
    """Resolve the ``openrappter`` console script next to the running
    interpreter first (fresh-venv case), falling back to PATH."""
    candidate = os.path.join(os.path.dirname(sys.executable), "openrappter")
    if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        return candidate
    found = shutil.which("openrappter")
    if found:
        return found
    print("FATAL: could not locate the 'openrappter' console script "
          f"(checked {candidate!r} and PATH)")
    sys.exit(2)


def _wait_for_health(host: str, port: int, proc: subprocess.Popen) -> dict:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"gateway process exited early with code {proc.returncode} "
                "before becoming healthy"
            )
        try:
            with urllib.request.urlopen(f"http://{host}:{port}/health", timeout=2) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if body.get("status") == "ok":
                    return body
                last_error = RuntimeError(f"health status not ok yet: {body}")
        except (urllib.error.URLError, ConnectionRefusedError, OSError) as exc:
            last_error = exc
        time.sleep(HEALTH_POLL_INTERVAL_SECONDS)
    raise TimeoutError(f"gateway never became healthy within {HEALTH_TIMEOUT_SECONDS}s: {last_error}")


def _get_status(host: str, port: int) -> dict:
    with urllib.request.urlopen(f"http://{host}:{port}/status", timeout=5) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def _ws_connect_expect_unauthorized(host: str, port: int, bad_token: str) -> None:
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(
            f"ws://{host}:{port}/ws", timeout=WS_TIMEOUT_SECONDS
        ) as ws:
            await ws.send_json(
                {"type": "req", "id": "1", "method": "connect", "params": {"auth": {"token": bad_token}}}
            )
            msg = await asyncio.wait_for(ws.receive(), timeout=WS_TIMEOUT_SECONDS)
            frame = json.loads(msg.data)
            if frame.get("ok") is not False or not isinstance(frame.get("error"), dict):
                raise AssertionError(f"expected an UNAUTHORIZED error frame, got: {frame}")
            if frame["error"].get("code") != -32000:
                raise AssertionError(f"expected error code -32000 (UNAUTHORIZED), got: {frame}")


async def _ws_connect_expect_success(host: str, port: int, token: str, expected_version: str) -> None:
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(
            f"ws://{host}:{port}/ws", timeout=WS_TIMEOUT_SECONDS
        ) as ws:
            await ws.send_json(
                {"type": "req", "id": "1", "method": "connect", "params": {"auth": {"token": token}}}
            )
            msg = await asyncio.wait_for(ws.receive(), timeout=WS_TIMEOUT_SECONDS)
            frame = json.loads(msg.data)
            if frame.get("ok") is not True:
                raise AssertionError(f"expected successful connect handshake, got: {frame}")
            server_info = frame.get("payload", {}).get("server", {})
            if server_info.get("version") != expected_version:
                raise AssertionError(
                    f"handshake server.version {server_info.get('version')!r} != "
                    f"expected {expected_version!r}"
                )

            await ws.send_json({"type": "req", "id": "2", "method": "health", "params": {}})
            msg = await asyncio.wait_for(ws.receive(), timeout=WS_TIMEOUT_SECONDS)
            frame = json.loads(msg.data)
            if frame.get("ok") is not True or frame.get("payload", {}).get("status") != "ok":
                raise AssertionError(f"expected ok 'health' RPC result, got: {frame}")


def main() -> int:
    openrappter_bin = _find_openrappter_bin()
    host = "127.0.0.1"
    port = _free_tcp_port()
    correct_token = secrets.token_hex(16)
    wrong_token = secrets.token_hex(16)

    tmp_home = tempfile.mkdtemp(prefix="openrappter-gateway-smoke-home-")
    log_path = os.path.join(tmp_home, "gateway.log")
    proc: subprocess.Popen | None = None
    try:
        env = dict(os.environ)
        env["HOME"] = tmp_home
        env.pop("OPENRAPPTER_GATEWAY_TOKEN", None)

        with open(log_path, "wb") as log_file:
            proc = subprocess.Popen(
                [
                    openrappter_bin,
                    "--gateway",
                    "--gateway-host", host,
                    "--gateway-port", str(port),
                    "--gateway-token", correct_token,
                ],
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )

            health = _wait_for_health(host, port, proc)
            version = health.get("version")
            if not version or version == "unknown":
                raise AssertionError(f"expected a real version in /health, got: {health}")

            status = _get_status(host, port)
            if not status.get("running"):
                raise AssertionError(f"/status reports not running: {status}")
            if status.get("version") != version:
                raise AssertionError(
                    f"/status version {status.get('version')!r} != /health version {version!r}"
                )

            asyncio.run(_ws_connect_expect_unauthorized(host, port, wrong_token))
            asyncio.run(_ws_connect_expect_success(host, port, correct_token, version))

        print(f"OK: gateway smoke passed (version={version}, host={host}, port={port})")
        return 0
    except Exception as exc:
        print(f"FAIL: gateway smoke failed: {exc}")
        if os.path.exists(log_path):
            print("---- gateway process log (tail) ----")
            with open(log_path, "r", errors="replace") as f:
                lines = f.readlines()
            print("".join(lines[-100:]))
        return 1
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        shutil.rmtree(tmp_home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
