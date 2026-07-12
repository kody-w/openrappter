"""
Shared provider contract: message/result models and error taxonomy.

Mirrors the shape of ``typescript/src/providers/types.ts`` (``Message``,
``ProviderResponse``) closely enough for cross-runtime familiarity, while
staying minimal — this package only needs to support a bounded,
OpenAI-compatible chat-completions round trip for the provider/channel
bridge, not full parity with every TypeScript provider feature (tool
calls, streaming, embeddings).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional

VALID_ROLES = ("system", "user", "assistant", "tool")


@dataclass
class ProviderMessage:
    """A single chat message sent to a provider."""

    role: str
    content: str

    def __post_init__(self) -> None:
        if self.role not in VALID_ROLES:
            raise ValueError(f"Invalid message role: {self.role!r}")


@dataclass
class ChatOptions:
    """Per-request overrides. All fields are optional and bounded."""

    model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    timeout: Optional[float] = None


@dataclass
class ProviderResponse:
    """Normalized provider result. Never carries the raw upstream payload —
    only the fields the caller needs, so no incidental credential/PII
    retention happens beyond the lifetime of a single call."""

    content: Optional[str]
    model: str = ""
    finish_reason: Optional[str] = None
    usage: Dict[str, int] = field(default_factory=dict)


class ProviderError(Exception):
    """Base class for provider errors.

    Messages must never include API keys, tokens, or full request/response
    bodies — only bounded, credential-free descriptions safe to surface to
    RPC clients and logs.
    """


class ProviderTimeoutError(ProviderError):
    """Raised when a provider call exceeds its bounded timeout."""


class ProviderUnavailableError(ProviderError):
    """Raised when the provider endpoint could not be reached at all."""


class ProviderResponseTooLargeError(ProviderError):
    """Raised when a provider response exceeds the configured byte cap."""
