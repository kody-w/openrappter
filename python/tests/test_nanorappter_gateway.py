"""The nanorappter gateway's HTTP surface.

This module had no tests at all. It also had no __main__.py, so the
`python3 -m nanorappter ...` command that its own docstring and help text
advertise could not run -- which is the likeliest reason nobody noticed that
every malformed request crashed the handler and returned nothing, or that a
single connection could take the whole gateway offline.

Measured against the real server before the fix:

    Content-Length: -1, one byte, socket held open
        -> every other caller times out until the attacker disconnects
    Content-Length: abc          -> no response, traceback, connection closed
    body `not json`              -> no response, traceback, connection closed
    body `[1,2]` (valid JSON)    -> no response, AttributeError on .get()

The -1 case is the sharp one: rfile.read(-1) means "read until EOF", and the
server was single-threaded, so one held socket blocked the accept loop.
"""
from __future__ import annotations

import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanorappter import MAX_BODY_BYTES, Gateway, NanoAgent, serve  # noqa: E402


class Echo(NanoAgent):
    def perform(self, event, detail):
        return {"reply": event}


@pytest.fixture(scope="module")
def gateway_port():
    """A real nanorappter gateway on an ephemeral port.

    Both server classes are patched, not just the threading one, so that a
    change of server class shows up as a failing assertion about behaviour
    rather than as a fixture that could not bind.
    """
    import http.server

    gw = Gateway()
    gw.register("bot", Echo("bot", "echoes"))

    holder: dict[str, int] = {}
    originals = {
        name: getattr(http.server, name)
        for name in ("HTTPServer", "ThreadingHTTPServer")
    }

    def ephemeral(base):
        class Ephemeral(base):  # type: ignore[misc, valid-type]
            def __init__(self, addr, handler):
                super().__init__((addr[0], 0), handler)
                holder["port"] = self.server_address[1]

        return Ephemeral

    for name, base in originals.items():
        setattr(http.server, name, ephemeral(base))
    try:
        threading.Thread(target=lambda: serve(gw, 0), daemon=True).start()
        deadline = time.time() + 5
        while "port" not in holder and time.time() < deadline:
            time.sleep(0.02)
        assert "port" in holder, "gateway did not start"
        yield holder["port"]
    finally:
        for name, base in originals.items():
            setattr(http.server, name, base)


def _request(port: int, payload: bytes, timeout: float = 5.0) -> bytes:
    """Send raw bytes, read the whole response. b'' means nothing came back."""
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    sock.settimeout(timeout)
    try:
        sock.sendall(payload)
        chunks = []
        while True:
            block = sock.recv(65536)
            if not block:
                break
            chunks.append(block)
        return b"".join(chunks)
    except (socket.timeout, ConnectionError):
        return b""
    finally:
        sock.close()


def _post(
    body: bytes,
    content_length: object | None = None,
    *,
    host: str = "t",
    origin: str | None = None,
    content_type: str = "application/json",
) -> bytes:
    declared = len(body) if content_length is None else content_length
    headers = [
        b"POST / HTTP/1.1",
        f"Host: {host}".encode(),
        b"Connection: close",
        f"Content-Type: {content_type}".encode(),
        b"Content-Length: " + str(declared).encode(),
    ]
    if origin is not None:
        headers.append(f"Origin: {origin}".encode())
    return b"\r\n".join(headers) + b"\r\n\r\n" + body


def _options(port: int, origin: str, method: str = "POST") -> bytes:
    return (
        b"OPTIONS / HTTP/1.1\r\n"
        + f"Host: 127.0.0.1:{port}\r\n".encode()
        + f"Origin: {origin}\r\n".encode()
        + f"Access-Control-Request-Method: {method}\r\n".encode()
        + b"Access-Control-Request-Headers: Content-Type\r\n"
        + b"Connection: close\r\n\r\n"
    )


def _status(response: bytes) -> int:
    assert response, "the server sent nothing at all"
    return int(response.split(b"\r\n", 1)[0].split(b" ")[1])


def _body(response: bytes) -> dict:
    return json.loads(response.split(b"\r\n\r\n", 1)[1])


def _headers(response: bytes) -> dict[str, str]:
    lines = response.split(b"\r\n\r\n", 1)[0].split(b"\r\n")[1:]
    return {
        name.decode().lower(): value.decode().strip()
        for name, value in (line.split(b":", 1) for line in lines)
    }


class TestTheDocumentedCommandRuns:
    """`python3 -m nanorappter` is what the docstring and help text promise."""

    def test_the_module_can_be_executed_as_documented(self):
        import subprocess

        result = subprocess.run(
            [sys.executable, "-m", "nanorappter", "status"],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)["runtime"] == "nanorappter"

    def test_help_is_reachable_the_same_way(self):
        import subprocess

        result = subprocess.run(
            [sys.executable, "-m", "nanorappter", "help"],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        assert result.returncode == 0, result.stderr
        assert "python3 -m nanorappter" in result.stdout


class TestMalformedRequestsAreAnswered:
    """Every one of these used to crash the handler and answer nothing."""

    def test_a_well_formed_request_still_works(self, gateway_port):
        response = _request(gateway_port, _post(b'{"agent_id":"bot","event":"hi"}'))
        assert _status(response) == 200
        assert _body(response)["reply"] == "hi"

    def test_a_non_numeric_content_length_is_refused(self, gateway_port):
        response = _request(gateway_port, _post(b"", content_length="abc"))
        assert _status(response) == 400
        assert "Content-Length" in _body(response)["error"]

    def test_a_negative_content_length_is_refused(self, gateway_port):
        response = _request(gateway_port, _post(b"", content_length=-1))
        assert _status(response) == 400

    def test_a_body_that_is_not_json_is_refused(self, gateway_port):
        response = _request(gateway_port, _post(b"not json at all"))
        assert _status(response) == 400
        assert "JSON" in _body(response)["error"]

    @pytest.mark.parametrize("payload", [b"[1,2]", b'"hello"', b"42", b"null"])
    def test_json_that_is_not_an_object_is_refused(self, gateway_port, payload):
        """Valid JSON, but .get() does not exist on it."""
        response = _request(gateway_port, _post(payload))
        assert _status(response) == 400
        assert "object" in _body(response)["error"]

    def test_an_empty_body_is_still_accepted(self, gateway_port):
        """Length 0 has always meant "{}" and must keep meaning it."""
        response = _request(gateway_port, _post(b""))
        assert _status(response) == 200


class TestBrowserOriginBoundary:
    def test_status_remains_cross_origin_readable(self, gateway_port):
        response = _request(
            gateway_port,
            (
                b"GET / HTTP/1.1\r\n"
                + f"Host: 127.0.0.1:{gateway_port}\r\n".encode()
                + b"Origin: https://status.example\r\n"
                + b"Connection: close\r\n\r\n"
            ),
        )
        assert _status(response) == 200
        assert _headers(response)["access-control-allow-origin"] == "*"

    def test_malicious_post_preflight_is_refused(self, gateway_port):
        response = _request(
            gateway_port,
            _options(gateway_port, "https://evil.example"),
        )
        assert _status(response) == 403
        assert "access-control-allow-origin" not in _headers(response)
        assert "access-control-allow-methods" not in _headers(response)

    @pytest.mark.parametrize(
        "origin,host",
        [
            ("https://evil.example", None),
            ("http://evil.example", "evil.example"),
            ("http://localhost:9999", None),
            ("null", None),
        ],
    )
    def test_cross_origin_simple_posts_cannot_invoke_agents(
        self, gateway_port, origin, host
    ):
        gateway_host = host or f"127.0.0.1:{gateway_port}"
        status_before = _body(
            _request(
                gateway_port,
                b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
            )
        )
        response = _request(
            gateway_port,
            _post(
                b'{"agent_id":"bot","event":"cross-origin"}',
                host=gateway_host,
                origin=origin,
                content_type="text/plain",
            ),
        )
        status_after = _body(
            _request(
                gateway_port,
                b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
            )
        )
        assert _status(response) == 403
        assert "access-control-allow-origin" not in _headers(response)
        assert (
            status_after["agents"]["bot"]["log_entries"]
            == status_before["agents"]["bot"]["log_entries"]
        )

    def test_exact_loopback_same_origin_preflight_and_post_are_allowed(
        self, gateway_port
    ):
        origin = f"http://127.0.0.1:{gateway_port}"
        preflight = _request(gateway_port, _options(gateway_port, origin))
        assert _status(preflight) == 204
        preflight_headers = _headers(preflight)
        assert preflight_headers["access-control-allow-origin"] == origin
        assert preflight_headers["access-control-allow-methods"] == "POST, OPTIONS"
        assert preflight_headers["vary"] == "Origin"

        response = _request(
            gateway_port,
            _post(
                b'{"agent_id":"bot","event":"same-origin"}',
                host=f"127.0.0.1:{gateway_port}",
                origin=origin,
            ),
        )
        assert _status(response) == 200
        assert _body(response)["reply"] == "same-origin"
        response_headers = _headers(response)
        assert response_headers["access-control-allow-origin"] == origin
        assert response_headers["vary"] == "Origin"

    def test_no_origin_text_plain_cannot_invoke_agents(self, gateway_port):
        status_before = _body(
            _request(
                gateway_port,
                b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
            )
        )
        response = _request(
            gateway_port,
            _post(
                b'{"agent_id":"bot","event":"simple-content-type"}',
                content_type="text/plain",
            ),
        )
        status_after = _body(
            _request(
                gateway_port,
                b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n",
            )
        )
        assert _status(response) == 415
        assert (
            status_after["agents"]["bot"]["log_entries"]
            == status_before["agents"]["bot"]["log_entries"]
        )

    def test_json_content_type_parameters_remain_compatible(self, gateway_port):
        response = _request(
            gateway_port,
            _post(
                b'{"agent_id":"bot","event":"json-charset"}',
                content_type="application/json; charset=utf-8",
            ),
        )
        assert _status(response) == 200
        assert _body(response)["reply"] == "json-charset"


class TestOneCallerCannotStallTheRest:
    """The whole gateway used to stop while one socket was held open."""

    def test_a_held_negative_length_request_does_not_block_other_callers(self, gateway_port):
        attacker = socket.create_connection(("127.0.0.1", gateway_port), timeout=5)
        try:
            attacker.sendall(
                b"POST / HTTP/1.1\r\nHost: t\r\nContent-Length: -1\r\n\r\nA"
            )
            time.sleep(0.3)
            response = _request(gateway_port, b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n", timeout=4)
            assert _status(response) == 200, "one held socket stalled the gateway"
        finally:
            attacker.close()

    def test_a_stalled_upload_does_not_block_other_callers(self, gateway_port):
        """Claims a legitimate size, sends nothing, never closes."""
        attacker = socket.create_connection(("127.0.0.1", gateway_port), timeout=5)
        try:
            attacker.sendall(b"POST / HTTP/1.1\r\nHost: t\r\nContent-Length: 1000\r\n\r\n")
            time.sleep(0.3)
            response = _request(gateway_port, b"GET / HTTP/1.1\r\nHost: t\r\nConnection: close\r\n\r\n", timeout=4)
            assert _status(response) == 200
        finally:
            attacker.close()


class TestTheBodyCap:
    def test_the_cap_is_the_same_two_megabytes_the_other_runtimes_use(self):
        assert MAX_BODY_BYTES == 2 * 1024 * 1024

    def test_a_claimed_gigabyte_is_refused_on_the_claim_alone(self, gateway_port):
        response = _request(gateway_port, _post(b"{}", content_length=1024**3))
        assert _status(response) == 413

    def test_a_body_exactly_at_the_cap_is_not_refused_for_being_too_large(self, gateway_port):
        """A ceiling, not a fence somewhere inside it. Pins > rather than >=.

        The payload is built to be exactly MAX_BODY_BYTES. An approximate size
        here lets an off-by-one through: a body merely *near* the cap passes
        under both > and >=, so the test would prove nothing about which one
        the server uses.
        """
        prefix = b'{"agent_id":"bot","event":"x","pad":"'
        suffix = b'"}'
        payload = prefix + b"a" * (MAX_BODY_BYTES - len(prefix) - len(suffix)) + suffix
        assert len(payload) == MAX_BODY_BYTES
        response = _request(gateway_port, _post(payload), timeout=15)
        assert _status(response) != 413
