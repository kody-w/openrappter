"""
openrappter Channels Package

Multi-channel messaging: BaseChannel abstraction, message types, registry,
a concrete local/offline WebhookChannel, and the ProviderChannelBridge
dispatcher that routes inbound channel messages through an LLM provider.
"""

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.channels.registry import ChannelRegistry
from openrappter.channels.webhook import WebhookChannel, ChannelConnectionError
from openrappter.channels.bridge import ProviderChannelBridge, ChannelDispatchError

__all__ = [
    'BaseChannel',
    'IncomingMessage',
    'OutgoingMessage',
    'ChannelRegistry',
    'WebhookChannel',
    'ChannelConnectionError',
    'ProviderChannelBridge',
    'ChannelDispatchError',
]
