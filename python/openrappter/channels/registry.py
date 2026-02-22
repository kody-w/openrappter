from openrappter.channels.base import OutgoingMessage


class ChannelRegistry:
    def __init__(self):
        self._channels = {}  # name -> BaseChannel

    def register(self, channel):
        self._channels[channel.name] = channel

    def unregister(self, name):
        self._channels.pop(name, None)

    def has(self, name):
        return name in self._channels

    def get(self, name):
        return self._channels.get(name)

    def names(self):
        return list(self._channels.keys())

    def list(self):
        return list(self._channels.values())

    @property
    def size(self):
        return len(self._channels)

    def connect_all(self):
        for ch in self._channels.values():
            ch.connect()

    def disconnect_all(self):
        for ch in self._channels.values():
            ch.disconnect()

    def send_message(self, channel_id, conversation_id, content):
        ch = self._channels.get(channel_id)
        if not ch:
            raise ValueError(f'Channel not found: {channel_id}')
        msg = OutgoingMessage(
            channel_id=channel_id,
            conversation_id=conversation_id,
            content=content,
        )
        ch.send(conversation_id, msg)
        return msg

    def get_status_list(self):
        return [ch.get_status() for ch in self._channels.values()]
