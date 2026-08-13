"""
ProviderChannelBridge — routes an inbound channel message through a
configured LLM provider and sends the provider's response back out
through the same channel.

This is the dispatcher referenced throughout the docs as the thing that
turns "a channel receives a message" into "a provider answered it and the
channel delivered the answer" without either side knowing about the
other's internals: the channel only knows about ``IncomingMessage``/
``OutgoingMessage`` and the provider only knows about
``ProviderMessage``/``ProviderResponse``.
"""

from __future__ import annotations

import logging
import time
import json
from typing import Callable, List, Optional

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.flight_recorder import (
    sanitize_flight_value,
    summarize_flight_error,
)
from openrappter.providers.types import ChatOptions, ProviderError, ProviderMessage

logger = logging.getLogger(__name__)


def _structured_content(value):
    parsed = value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            pass
    return sanitize_flight_value(parsed)


class ChannelDispatchError(Exception):
    """Raised when a bridge cannot complete a channel->provider->channel
    round trip. Wraps the underlying provider/channel error message only
    (never raw request/response bodies or credentials)."""


class ProviderChannelBridge:
    """Wires one channel to one provider.

    ``start()`` subscribes to the channel's inbound messages; each message
    is sent to the provider and the (successful or error) result is sent
    back out through the same channel. ``stop()`` unsubscribes, restoring
    the channel to having no bridge attached — call it before discarding
    the bridge, or when swapping in a different provider/channel pairing.
    """

    def __init__(
        self,
        channel: BaseChannel,
        provider: object,
        system_prompt: Optional[str] = None,
        chat_options: Optional[ChatOptions] = None,
    ) -> None:
        self.channel = channel
        self.provider = provider
        self.system_prompt = system_prompt
        self.chat_options = chat_options
        self._unsubscribe: Optional[Callable[[], None]] = None

    @property
    def active(self) -> bool:
        return (
            self._unsubscribe is not None
            and self.channel.has_message_handler(self._on_incoming)
        )

    def start(self) -> None:
        """Begin routing inbound channel messages to the provider. Idempotent."""
        if self.active:
            return
        if self._unsubscribe is not None:
            self._unsubscribe()
        self._unsubscribe = self.channel.on_message(self._on_incoming)

    def stop(self) -> None:
        """Stop routing inbound channel messages. Idempotent."""
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None

    def _build_messages(self, incoming: IncomingMessage) -> List[ProviderMessage]:
        messages: List[ProviderMessage] = []
        if self.system_prompt:
            messages.append(ProviderMessage(role="system", content=self.system_prompt))
        messages.append(ProviderMessage(role="user", content=incoming.content))
        return messages

    def _on_incoming(self, incoming: IncomingMessage) -> None:
        from openrappter.flight_recorder import ensure_flight_recorder_from_env

        recorder = ensure_flight_recorder_from_env()
        operation = lambda: self._dispatch_incoming(incoming, recorder)
        if recorder.current_trace():
            return operation()
        return recorder.run_trace(
            {
                "sessionId": incoming.conversation_id,
                "workspaceId": f"channel:{incoming.channel_id}",
            },
            operation,
        )

    def _dispatch_incoming(self, incoming: IncomingMessage, recorder) -> None:
        messages = self._build_messages(incoming)
        provider_id = str(
            getattr(self.provider, "id", None)
            or getattr(self.provider, "name", None)
            or self.provider.__class__.__name__
        )
        configured_model = (
            getattr(self.chat_options, "model", None)
            or getattr(self.provider, "model", None)
        )
        model_policy = (
            configured_model.strip()
            if isinstance(configured_model, str) and configured_model.strip()
            else None
        )
        started = time.monotonic()
        started_event = recorder.record({
            "kind": "provider.attempt.started",
            "source": "provider-channel-bridge",
            "status": "started",
            "providerId": provider_id,
            "metadata": {
                "messageCount": len(messages),
                "channelType": self.channel.type,
                **({"modelPolicy": model_policy} if model_policy else {}),
            },
            "payload": lambda: {
                "messages": [
                    {
                        "role": message.role,
                        "content": _structured_content(message.content),
                    }
                    for message in messages
                ]
            },
        })

        def within_provider():
            try:
                response = self.provider.chat(messages, self.chat_options)
            except Exception as exc:
                recorder.record({
                    "kind": "provider.attempt.failed",
                    "source": "provider-channel-bridge",
                    "status": "error",
                    "providerId": provider_id,
                    "durationMs": (time.monotonic() - started) * 1000,
                    "metadata": {
                        **summarize_flight_error(exc),
                        **({"modelPolicy": model_policy} if model_policy else {}),
                    },
                    "payload": lambda: {
                        "messages": [
                            {
                                "role": message.role,
                                "content": _structured_content(
                                    message.content
                                ),
                            }
                            for message in messages
                        ],
                        "error": exc,
                    },
                })
                # Re-raised as a channel-domain error rather than swallowed, so
                # the channel transport (e.g. WebhookChannel's HTTP response)
                # can surface a bounded, explicit failure to the caller instead
                # of silently answering with an empty/garbled message.
                if isinstance(exc, ProviderError):
                    raise ChannelDispatchError(str(exc)) from exc
                raise

            recorder.record({
                "kind": "provider.attempt.completed",
                "source": "provider-channel-bridge",
                "status": "success",
                "providerId": provider_id,
                **({"model": response.model} if response.model else {}),
                "durationMs": (time.monotonic() - started) * 1000,
                "metadata": {
                    "hadContent": bool(response.content),
                    "finishReason": response.finish_reason,
                    "usage": response.usage,
                    **({"modelPolicy": model_policy} if model_policy else {}),
                },
                "payload": lambda: {
                    "response": {
                        "content": _structured_content(response.content),
                        "model": response.model,
                        "finishReason": response.finish_reason,
                        "usage": response.usage,
                    }
                },
            })
            outgoing = OutgoingMessage(
                channel_id=incoming.channel_id,
                conversation_id=incoming.conversation_id,
                content=response.content or "",
                request_generation=incoming.request_generation,
            )
            self.channel.send(incoming.conversation_id, outgoing)

        return recorder.with_parent(
            started_event.get("id") if started_event is not None else None,
            within_provider,
        )
