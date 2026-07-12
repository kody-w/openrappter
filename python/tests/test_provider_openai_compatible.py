"""
Behavioral tests for openrappter.providers.OpenAICompatibleProvider.

These exercise the provider client against a real local HTTP server bound
to an OS-assigned ephemeral port (``http.server.ThreadingHTTPServer``) —
not a mocked client — so the total deadline, response-size caps, and
error-classification behavior are verified against real socket I/O.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from openrappter.providers.openai_compatible import OpenAICompatibleProvider
from openrappter.providers.types import (
    ProviderError,
    ProviderMessage,
    ProviderResponseTooLargeError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)


class _FakeOpenAIServer:
    """A tiny real HTTP server speaking a slice of the OpenAI chat-completions
    wire format, run on a background thread bound to 127.0.0.1:0."""

    def __init__(self, handler_factory):
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_port}/v1"


def _quiet(handler_cls):
    """Silence BaseHTTPRequestHandler's default stderr access logging."""
    handler_cls.log_message = lambda *a, **k: None
    return handler_cls


def _echo_handler(captured_headers=None):
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            if captured_headers is not None:
                captured_headers.append(dict(self.headers))
            last_user = next(
                (m["content"] for m in reversed(body.get("messages", [])) if m["role"] == "user"),
                "",
            )
            response = {
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 0,
                "model": body.get("model", "test-model"),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": f"echo: {last_user}"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7},
            }
            payload = json.dumps(response).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    return Handler


def test_chat_success_against_real_local_server():
    with _FakeOpenAIServer(_echo_handler()) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, api_key="unused", timeout=5.0)
        response = provider.chat([ProviderMessage(role="user", content="hello world")])
        assert response.content == "echo: hello world"
        assert response.usage == {"input_tokens": 3, "output_tokens": 4}
        assert response.finish_reason == "stop"


def test_authorization_header_sent_but_never_raised_in_errors():
    captured: list = []

    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            captured.append(dict(self.headers))
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = b'{"error": "nope"}'
            self.send_response(401)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, api_key="super-secret-token", timeout=5.0)
        with pytest.raises(ProviderError) as excinfo:
            provider.chat([ProviderMessage(role="user", content="hi")])

    assert captured, "server should have received the request"
    assert captured[0]["Authorization"] == "Bearer super-secret-token"
    assert "super-secret-token" not in str(excinfo.value)


def test_http_error_status_raises_provider_error():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = b'{"error": "boom"}'
            self.send_response(500)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, timeout=5.0)
        with pytest.raises(ProviderError):
            provider.chat([ProviderMessage(role="user", content="hi")])


def test_slow_server_raises_provider_timeout_error():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            time.sleep(2.0)
            payload = b"{}"
            self.send_response(200)
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, timeout=0.2)
        with pytest.raises(ProviderTimeoutError):
            provider.chat([ProviderMessage(role="user", content="hi")])


def test_trickling_response_obeys_total_wall_clock_deadline():
    response = {
        "model": "trickle-model",
        "choices": [
            {
                "message": {"role": "assistant", "content": "eventually complete"},
                "finish_reason": "stop",
            }
        ],
    }
    payload = json.dumps(response).encode()

    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            chunk_size = max(1, (len(payload) + 11) // 12)
            try:
                for offset in range(0, len(payload), chunk_size):
                    self.wfile.write(payload[offset : offset + chunk_size])
                    self.wfile.flush()
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError):
                pass

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, timeout=0.2)
        started = time.monotonic()
        with pytest.raises(ProviderTimeoutError):
            provider.chat([ProviderMessage(role="user", content="hi")])
        elapsed = time.monotonic() - started

    assert elapsed < 0.8


def test_oversized_response_raises_response_too_large_error():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = json.dumps({"choices": [{"message": {"content": "x" * 5000}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, timeout=5.0, max_response_bytes=100)
        with pytest.raises(ProviderResponseTooLargeError):
            provider.chat([ProviderMessage(role="user", content="hi")])


def test_oversized_response_headers_raise_response_too_large_error():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = b'{"choices":[{"message":{"content":"ok"}}]}'
            self.send_response(200)
            for index in range(8):
                self.send_header(f"X-Fill-{index}", "x" * 80)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(
            base_url=server.base_url,
            timeout=5.0,
            max_response_header_bytes=512,
        )
        with pytest.raises(ProviderResponseTooLargeError):
            provider.chat([ProviderMessage(role="user", content="hi")])


def test_connection_refused_raises_provider_unavailable_error():
    # Port 1 on loopback should reliably refuse connections without a real
    # server listening — no server is started for this test.
    provider = OpenAICompatibleProvider(base_url="http://127.0.0.1:1/v1", timeout=2.0)
    with pytest.raises(ProviderUnavailableError):
        provider.chat([ProviderMessage(role="user", content="hi")])


def test_invalid_json_response_raises_provider_error():
    @_quiet
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            payload = b"not json"
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    with _FakeOpenAIServer(Handler) as server:
        provider = OpenAICompatibleProvider(base_url=server.base_url, timeout=5.0)
        with pytest.raises(ProviderError):
            provider.chat([ProviderMessage(role="user", content="hi")])


def test_invalid_message_role_rejected():
    with pytest.raises(ValueError):
        ProviderMessage(role="bogus", content="hi")


def test_non_positive_timeout_rejected():
    with pytest.raises(ValueError):
        OpenAICompatibleProvider(timeout=0)


def test_non_positive_max_response_bytes_rejected():
    with pytest.raises(ValueError):
        OpenAICompatibleProvider(max_response_bytes=0)


def test_non_positive_max_response_header_bytes_rejected():
    with pytest.raises(ValueError):
        OpenAICompatibleProvider(max_response_header_bytes=0)
