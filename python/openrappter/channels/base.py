from abc import ABC, abstractmethod
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class IncomingMessage:
    channel_id: str
    conversation_id: str
    content: str
    sender_id: str = ''
    timestamp: float = field(default_factory=time.time)
    role: str = 'user'
    request_generation: str = field(default='', repr=False, compare=False)


@dataclass
class OutgoingMessage:
    channel_id: str
    conversation_id: str
    content: str
    timestamp: float = field(default_factory=time.time)
    role: str = 'assistant'
    request_generation: str = field(default='', repr=False, compare=False)


class BaseChannel(ABC):
    def __init__(self, name: str, channel_type: str = 'generic'):
        self.name = name
        self.type = channel_type
        self.connected = False
        self.message_count = 0
        self._handlers = []
        self._handlers_lock = threading.RLock()

    @abstractmethod
    def connect(self):
        pass

    @abstractmethod
    def disconnect(self):
        pass

    @abstractmethod
    def send(self, conversation_id: str, message: OutgoingMessage):
        pass

    def on_message(self, handler: Callable):
        """Subscribe to inbound messages until the returned callback is used.

        Subscriptions belong to the channel object, not to one transport
        connection. They therefore survive disconnect/reconnect cycles.
        """
        with self._handlers_lock:
            self._handlers.append(handler)

        def unsubscribe():
            with self._handlers_lock:
                if handler in self._handlers:
                    self._handlers.remove(handler)

        return unsubscribe

    def has_message_handler(self, handler: Callable) -> bool:
        with self._handlers_lock:
            return handler in self._handlers

    def emit_message(self, message: IncomingMessage):
        self.message_count += 1
        with self._handlers_lock:
            handlers = tuple(self._handlers)
        for handler in handlers:
            handler(message)

    def get_status(self):
        return {
            'id': self.name,
            'type': self.type,
            'connected': self.connected,
            'message_count': self.message_count,
        }
