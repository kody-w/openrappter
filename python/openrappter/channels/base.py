from abc import ABC, abstractmethod
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


@dataclass
class OutgoingMessage:
    channel_id: str
    conversation_id: str
    content: str
    timestamp: float = field(default_factory=time.time)
    role: str = 'assistant'


class BaseChannel(ABC):
    def __init__(self, name: str, channel_type: str = 'generic'):
        self.name = name
        self.type = channel_type
        self.connected = False
        self.message_count = 0
        self._handlers = []

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
        self._handlers.append(handler)

        def unsubscribe():
            if handler in self._handlers:
                self._handlers.remove(handler)

        return unsubscribe

    def emit_message(self, message: IncomingMessage):
        self.message_count += 1
        for handler in self._handlers:
            handler(message)

    def get_status(self):
        return {
            'id': self.name,
            'type': self.type,
            'connected': self.connected,
            'message_count': self.message_count,
        }
