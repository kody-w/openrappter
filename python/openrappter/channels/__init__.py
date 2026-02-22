"""
openrappter Channels Package

Multi-channel messaging: BaseChannel abstraction, message types, and registry.
"""

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.channels.registry import ChannelRegistry

__all__ = [
    'BaseChannel',
    'IncomingMessage',
    'OutgoingMessage',
    'ChannelRegistry',
]
