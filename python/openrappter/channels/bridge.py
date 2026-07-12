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
from typing import Callable, List, Optional

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.providers.types import ChatOptions, ProviderError, ProviderMessage

logger = logging.getLogger(__name__)


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
        messages = self._build_messages(incoming)
        try:
            response = self.provider.chat(messages, self.chat_options)
        except ProviderError as exc:
            # Re-raised as a channel-domain error rather than swallowed, so
            # the channel transport (e.g. WebhookChannel's HTTP response)
            # can surface a bounded, explicit failure to the caller instead
            # of silently answering with an empty/garbled message.
            raise ChannelDispatchError(str(exc)) from exc

        outgoing = OutgoingMessage(
            channel_id=incoming.channel_id,
            conversation_id=incoming.conversation_id,
            content=response.content or "",
            request_generation=incoming.request_generation,
        )
        self.channel.send(incoming.conversation_id, outgoing)
