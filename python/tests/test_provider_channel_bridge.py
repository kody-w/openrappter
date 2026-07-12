"""
Focused unit tests for openrappter.channels.bridge.ProviderChannelBridge.

Uses a minimal in-memory BaseChannel and a stand-in provider object to
isolate the bridge's own dispatch/error-propagation/idempotence logic from
network I/O. The real network round trip (WebhookChannel + a real
OpenAI-compatible HTTP provider) is covered by
``tests/test_e2e_provider_channel_gateway.py``.
"""

from __future__ import annotations

import pytest
import requests

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.channels.bridge import ChannelDispatchError, ProviderChannelBridge
from openrappter.channels.webhook import WebhookChannel
from openrappter.providers.types import ProviderError, ProviderMessage, ProviderResponse


class InMemoryChannel(BaseChannel):
    def __init__(self):
        super().__init__("mem", channel_type="mock")
        self.sent = []

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.connected = False

    def send(self, conversation_id, message: OutgoingMessage):
        self.sent.append(message)


class FakeProvider:
    def __init__(self, response=None, error=None):
        self.name = "fake"
        self._response = response
        self._error = error
        self.received_messages = None

    def chat(self, messages, options=None):
        self.received_messages = messages
        if self._error is not None:
            raise self._error
        return self._response


def test_bridge_routes_inbound_to_provider_and_sends_response_back():
    channel = InMemoryChannel()
    provider = FakeProvider(response=ProviderResponse(content="hello back"))
    bridge = ProviderChannelBridge(channel, provider, system_prompt="be nice")
    bridge.start()

    channel.emit_message(IncomingMessage(channel_id="mem", conversation_id="c1", content="hi"))

    assert len(channel.sent) == 1
    assert channel.sent[0].content == "hello back"
    assert channel.sent[0].conversation_id == "c1"

    # System prompt is prepended ahead of the user message.
    assert provider.received_messages[0] == ProviderMessage(role="system", content="be nice")
    assert provider.received_messages[1] == ProviderMessage(role="user", content="hi")


def test_bridge_without_system_prompt_sends_user_message_only():
    channel = InMemoryChannel()
    provider = FakeProvider(response=ProviderResponse(content="ok"))
    bridge = ProviderChannelBridge(channel, provider)
    bridge.start()

    channel.emit_message(IncomingMessage(channel_id="mem", conversation_id="c1", content="hi"))

    assert len(provider.received_messages) == 1
    assert provider.received_messages[0].role == "user"


def test_bridge_provider_error_raised_as_channel_dispatch_error():
    channel = InMemoryChannel()
    provider = FakeProvider(error=ProviderError("upstream exploded"))
    bridge = ProviderChannelBridge(channel, provider)
    bridge.start()

    with pytest.raises(ChannelDispatchError):
        channel.emit_message(IncomingMessage(channel_id="mem", conversation_id="c1", content="hi"))

    # No outgoing message should have been sent on failure.
    assert channel.sent == []


def test_bridge_start_is_idempotent_and_only_dispatches_once_per_message():
    channel = InMemoryChannel()
    provider = FakeProvider(response=ProviderResponse(content="ok"))
    bridge = ProviderChannelBridge(channel, provider)
    bridge.start()
    bridge.start()  # second start() must not double-subscribe

    channel.emit_message(IncomingMessage(channel_id="mem", conversation_id="c1", content="hi"))

    assert len(channel.sent) == 1


def test_bridge_stop_unsubscribes_and_is_idempotent():
    channel = InMemoryChannel()
    provider = FakeProvider(response=ProviderResponse(content="ok"))
    bridge = ProviderChannelBridge(channel, provider)
    bridge.start()
    bridge.stop()
    bridge.stop()  # idempotent

    channel.emit_message(IncomingMessage(channel_id="mem", conversation_id="c1", content="hi"))

    assert channel.sent == []
    assert bridge.active is False


def test_active_bridge_survives_webhook_disconnect_reconnect():
    channel = WebhookChannel(
        name="bridge-reconnect",
        port=0,
        request_timeout=0.2,
    )
    provider = FakeProvider(response=ProviderResponse(content="reconnected"))
    bridge = ProviderChannelBridge(channel, provider)
    bridge.start()
    assert bridge.active is True

    channel.connect()
    try:
        first = requests.post(
            channel.url,
            json={"content": "first", "conversation_id": "c1"},
            timeout=0.5,
        )
        assert first.status_code == 200
        assert first.json()["content"] == "reconnected"

        channel.disconnect()
        assert bridge.active is True
        assert channel.has_message_handler(bridge._on_incoming)

        channel.connect()
        second = requests.post(
            channel.url,
            json={"content": "second", "conversation_id": "c2"},
            timeout=0.5,
        )
        assert second.status_code == 200
        assert second.json()["content"] == "reconnected"

        bridge.stop()
        assert bridge.active is False
        assert not channel.has_message_handler(bridge._on_incoming)
    finally:
        bridge.stop()
        channel.disconnect()
