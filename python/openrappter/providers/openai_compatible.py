"""
OpenAI-compatible provider client.

Speaks the OpenAI ``/chat/completions`` wire format against a configurable
``base_url`` — this lets a single client target the real OpenAI API, a
local Ollama server (which exposes an OpenAI-compatible endpoint), or any
other self-hosted OpenAI-compatible server (including the fake server used
by tests), selected purely by configuration. No vendor-specific SDK is
required for this bounded slice; if a full-featured OpenAI/Anthropic/Ollama
client is added later it can implement the same ``chat()`` contract.

Bounded by design:
  - an explicit total wall-clock deadline (``timeout``), covering connect,
    request upload, response headers, and the complete response body, after which
    ``ProviderTimeoutError`` is raised
  - explicit response header/body caps, after which
    ``ProviderResponseTooLargeError`` is raised — the response body is
    read incrementally so an oversized body cannot be buffered in full
  - never logs the API key, Authorization header, or request/response
    bodies
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, List, Optional

import aiohttp

from openrappter.providers.types import (
    ChatOptions,
    ProviderError,
    ProviderMessage,
    ProviderResponse,
    ProviderResponseTooLargeError,
    ProviderTimeoutError,
    ProviderUnavailableError,
)

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
DEFAULT_MAX_RESPONSE_HEADER_BYTES = 64 * 1024
DEFAULT_MAX_RESPONSE_HEADERS = 128
DEFAULT_MAX_HEADER_FIELD_BYTES = 8190


class OpenAICompatibleProvider:
    """LLM provider client for any OpenAI-compatible ``/chat/completions`` endpoint."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        api_key: Optional[str] = None,
        model: str = DEFAULT_MODEL,
        timeout: float = DEFAULT_TIMEOUT,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        name: str = "openai-compatible",
        max_response_header_bytes: int = DEFAULT_MAX_RESPONSE_HEADER_BYTES,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        if max_response_header_bytes <= 0:
            raise ValueError("max_response_header_bytes must be positive")

        self.name = name
        self.base_url = base_url.rstrip("/")
        # Falls back to the environment only when the caller did not pass
        # a key explicitly; local/offline servers typically need no key.
        self._api_key = api_key if api_key is not None else os.environ.get("OPENAI_API_KEY")
        self.model = model
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes
        self.max_response_header_bytes = max_response_header_bytes

    def is_available(self) -> bool:
        """Local/offline adapters are always considered dialable; actual
        reachability is only known once ``chat()`` is attempted."""
        return True

    def chat(
        self, messages: List[ProviderMessage], options: Optional[ChatOptions] = None
    ) -> ProviderResponse:
        options = options or ChatOptions()
        payload: Dict[str, Any] = {
            "model": options.model or self.model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        if options.temperature is not None:
            payload["temperature"] = options.temperature
        if options.max_tokens is not None:
            payload["max_tokens"] = options.max_tokens

        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"

        timeout = self.timeout if options.timeout is None else options.timeout
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        url = f"{self.base_url}/chat/completions"

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise ProviderError(
                f"Provider '{self.name}' synchronous chat must run outside an active event loop"
            )

        try:
            status_code, raw_body = asyncio.run(
                self._post_bounded(url, payload, headers, timeout)
            )
        except (asyncio.TimeoutError, TimeoutError):
            raise ProviderTimeoutError(
                f"Provider '{self.name}' request timed out after {timeout}s"
            ) from None
        except aiohttp.ClientConnectorError:
            raise ProviderUnavailableError(f"Provider '{self.name}' is unreachable") from None
        except ProviderError:
            raise
        except aiohttp.ClientError as exc:
            raise ProviderError(
                f"Provider '{self.name}' request failed: {exc.__class__.__name__}"
            ) from None

        if status_code >= 400:
            raise ProviderError(f"Provider '{self.name}' returned HTTP {status_code}")

        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError:
            raise ProviderError(f"Provider '{self.name}' returned an invalid JSON response") from None

        choices = data.get("choices") or []
        if not choices:
            raise ProviderError(f"Provider '{self.name}' response contained no choices")

        message = choices[0].get("message") or {}
        usage = data.get("usage") or {}

        return ProviderResponse(
            content=message.get("content"),
            model=data.get("model") or payload["model"],
            finish_reason=choices[0].get("finish_reason"),
            usage={
                "input_tokens": int(usage.get("prompt_tokens", 0) or 0),
                "output_tokens": int(usage.get("completion_tokens", 0) or 0),
            },
        )

    async def _post_bounded(
        self,
        url: str,
        payload: Dict[str, Any],
        headers: Dict[str, str],
        timeout: float,
    ) -> tuple[int, bytes]:
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        connector = aiohttp.TCPConnector(limit=1, force_close=True)
        field_limit = min(DEFAULT_MAX_HEADER_FIELD_BYTES, self.max_response_header_bytes)
        read_buffer_size = min(64 * 1024, self.max_response_bytes + 1)
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=client_timeout,
            trust_env=False,
            read_bufsize=read_buffer_size,
            max_line_size=field_limit,
            max_field_size=field_limit,
            max_headers=DEFAULT_MAX_RESPONSE_HEADERS,
        ) as session:
            async with session.post(
                url,
                json=payload,
                headers=headers,
                allow_redirects=False,
            ) as response:
                self._validate_response_headers(response)
                raw_body = await self._read_bounded(response)
                return response.status, raw_body

    def _validate_response_headers(self, response: aiohttp.ClientResponse) -> None:
        total = 2
        for name, value in response.raw_headers:
            total += len(name) + len(value) + 4
            if total > self.max_response_header_bytes:
                raise ProviderResponseTooLargeError(
                    f"Provider '{self.name}' response headers exceeded "
                    f"{self.max_response_header_bytes} bytes"
                )

        content_length = response.content_length
        if content_length is not None and content_length > self.max_response_bytes:
            raise ProviderResponseTooLargeError(
                f"Provider '{self.name}' response exceeded {self.max_response_bytes} bytes"
            )

    async def _read_bounded(self, response: aiohttp.ClientResponse) -> bytes:
        body = bytearray()
        total = 0
        chunk_size = min(8192, self.max_response_bytes + 1)
        async for chunk in response.content.iter_chunked(chunk_size):
            if not chunk:
                continue
            total += len(chunk)
            if total > self.max_response_bytes:
                raise ProviderResponseTooLargeError(
                    f"Provider '{self.name}' response exceeded {self.max_response_bytes} bytes"
                )
            body.extend(chunk)
        return bytes(body)


def create_openai_compatible_provider(
    base_url: str = DEFAULT_BASE_URL, api_key: Optional[str] = None, **kwargs: Any
) -> OpenAICompatibleProvider:
    return OpenAICompatibleProvider(base_url=base_url, api_key=api_key, **kwargs)
