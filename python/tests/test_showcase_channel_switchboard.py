import pytest
import time

from openrappter.channels.base import BaseChannel, IncomingMessage, OutgoingMessage
from openrappter.channels.registry import ChannelRegistry


class MockChannel(BaseChannel):
    def __init__(self, name: str, channel_type: str = 'mock'):
        super().__init__(name, channel_type)
        self.sent_messages = []

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.connected = False

    def send(self, conversation_id: str, message: OutgoingMessage):
        self.sent_messages.append(message)

    def trigger_message(self, msg: IncomingMessage):
        self.emit_message(msg)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def registry():
    reg = ChannelRegistry()
    reg.register(MockChannel('slack', 'slack'))
    reg.register(MockChannel('discord', 'discord'))
    reg.register(MockChannel('telegram', 'telegram'))
    return reg


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_register_multiple_channels_names_and_size(registry):
    """Register multiple channels and verify names()/size."""
    names = registry.names()
    assert set(names) == {'slack', 'discord', 'telegram'}
    assert registry.size == 3


def test_get_channel_by_name(registry):
    """Get channel by name returns the correct channel."""
    ch = registry.get('discord')
    assert ch is not None
    assert ch.name == 'discord'
    assert ch.type == 'discord'

    missing = registry.get('nonexistent')
    assert missing is None


def test_connect_all_sets_connected_true(registry):
    """connect_all() sets connected=True on all channels."""
    for ch in registry.list():
        assert ch.connected is False

    registry.connect_all()

    for ch in registry.list():
        assert ch.connected is True


def test_disconnect_all_sets_connected_false(registry):
    """disconnect_all() sets connected=False on all channels."""
    registry.connect_all()
    for ch in registry.list():
        assert ch.connected is True

    registry.disconnect_all()

    for ch in registry.list():
        assert ch.connected is False


def test_send_message_routes_to_correct_channel(registry):
    """send_message() routes to the correct channel and records in sent_messages."""
    msg = registry.send_message('slack', 'conv-1', 'Hello Slack!')

    slack_ch = registry.get('slack')
    discord_ch = registry.get('discord')

    assert len(slack_ch.sent_messages) == 1
    assert slack_ch.sent_messages[0].content == 'Hello Slack!'
    assert slack_ch.sent_messages[0].channel_id == 'slack'
    assert slack_ch.sent_messages[0].conversation_id == 'conv-1'

    # Other channels should not have received the message
    assert len(discord_ch.sent_messages) == 0


def test_on_message_handler_fires_on_trigger(registry):
    """on_message handler fires when trigger_message is called."""
    slack_ch = registry.get('slack')
    received = []

    slack_ch.on_message(lambda msg: received.append(msg))

    incoming = IncomingMessage(
        channel_id='slack',
        conversation_id='conv-42',
        content='ping',
        sender_id='user-1',
    )
    slack_ch.trigger_message(incoming)

    assert len(received) == 1
    assert received[0].content == 'ping'
    assert received[0].sender_id == 'user-1'
    assert slack_ch.message_count == 1


def test_get_status_list_returns_status_for_all_channels(registry):
    """get_status_list() returns status dicts for all channels."""
    registry.connect_all()
    status_list = registry.get_status_list()

    assert len(status_list) == 3

    by_id = {s['id']: s for s in status_list}
    assert set(by_id.keys()) == {'slack', 'discord', 'telegram'}

    for s in status_list:
        assert s['connected'] is True
        assert 'type' in s
        assert 'message_count' in s
