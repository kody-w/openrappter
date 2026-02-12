import { describe, it, expect } from 'vitest';
import { BlueBubblesChannel } from '../../channels/bluebubbles.js';
import { NostrChannel } from '../../channels/nostr.js';
import { TwitchChannel } from '../../channels/twitch.js';
import { MattermostChannel } from '../../channels/mattermost.js';
import { LINEChannel } from '../../channels/line.js';
import { FeishuChannel } from '../../channels/feishu.js';
import type { ThreadContext } from '../../channels/thread.js';
import type { IncomingMessage, OutgoingMessage } from '../../channels/types.js';

describe('Thread Context', () => {
  it('should define thread context shape', () => {
    const mockContext: ThreadContext = {
      threadId: 'thread-123',
      channelId: 'channel-456',
      parentMessageId: 'msg-789',
      title: 'Discussion Thread',
    };

    expect(mockContext.threadId).toBe('thread-123');
    expect(mockContext.channelId).toBe('channel-456');
    expect(mockContext.parentMessageId).toBe('msg-789');
    expect(mockContext.title).toBe('Discussion Thread');
  });

  it('threadId and channelId should be required', () => {
    const mockContext: ThreadContext = {
      threadId: 'thread-123',
      channelId: 'channel-456',
    };

    expect(mockContext.threadId).toBeDefined();
    expect(mockContext.channelId).toBeDefined();
  });
});

describe('Channel Stubs', () => {
  describe('BlueBubblesChannel', () => {
    it('should instantiate', () => {
      const ch = new BlueBubblesChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new BlueBubblesChannel();
      expect(ch.type).toBe('bluebubbles');
    });

    it('should have correct name', () => {
      const ch = new BlueBubblesChannel();
      expect(ch.name).toBe('bluebubbles');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new BlueBubblesChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new BlueBubblesChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new BlueBubblesChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  describe('NostrChannel', () => {
    it('should instantiate', () => {
      const ch = new NostrChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new NostrChannel();
      expect(ch.type).toBe('nostr');
    });

    it('should have correct name', () => {
      const ch = new NostrChannel();
      expect(ch.name).toBe('nostr');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new NostrChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new NostrChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new NostrChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  describe('TwitchChannel', () => {
    it('should instantiate', () => {
      const ch = new TwitchChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new TwitchChannel();
      expect(ch.type).toBe('twitch');
    });

    it('should have correct name', () => {
      const ch = new TwitchChannel();
      expect(ch.name).toBe('twitch');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new TwitchChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new TwitchChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new TwitchChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  describe('MattermostChannel', () => {
    it('should instantiate', () => {
      const ch = new MattermostChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new MattermostChannel();
      expect(ch.type).toBe('mattermost');
    });

    it('should have correct name', () => {
      const ch = new MattermostChannel();
      expect(ch.name).toBe('mattermost');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new MattermostChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new MattermostChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new MattermostChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  describe('LINEChannel', () => {
    it('should instantiate', () => {
      const ch = new LINEChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new LINEChannel();
      expect(ch.type).toBe('line');
    });

    it('should have correct name', () => {
      const ch = new LINEChannel();
      expect(ch.name).toBe('line');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new LINEChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new LINEChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new LINEChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });

  describe('FeishuChannel', () => {
    it('should instantiate', () => {
      const ch = new FeishuChannel();
      expect(ch).toBeDefined();
    });

    it('should have correct type', () => {
      const ch = new FeishuChannel();
      expect(ch.type).toBe('feishu');
    });

    it('should have correct name', () => {
      const ch = new FeishuChannel();
      expect(ch.name).toBe('feishu');
    });

    it('connect() should throw not implemented', async () => {
      const ch = new FeishuChannel();
      await expect(ch.connect()).rejects.toThrow(/not yet implemented/i);
    });

    it('send() should throw not implemented', async () => {
      const ch = new FeishuChannel();
      await expect(ch.send({ channel: 'test', content: 'hi' })).rejects.toThrow(/not yet implemented/i);
    });

    it('disconnect() should not throw', async () => {
      const ch = new FeishuChannel();
      await expect(ch.disconnect()).resolves.not.toThrow();
    });
  });
});

describe('BaseChannel Extended Features', () => {
  it('sendTyping should be callable (no-op default)', async () => {
    const ch = new BlueBubblesChannel();
    await expect(ch.sendTyping('conv1')).resolves.not.toThrow();
  });

  it('react should be callable (no-op default)', async () => {
    const ch = new BlueBubblesChannel();
    await expect(ch.react('conv1', 'msg1', '👍')).resolves.not.toThrow();
  });

  it('removeReaction should be callable (no-op default)', async () => {
    const ch = new BlueBubblesChannel();
    await expect(ch.removeReaction('conv1', 'msg1', '👍')).resolves.not.toThrow();
  });

  it('replyInThread should call send (and throw for stubs)', async () => {
    const ch = new BlueBubblesChannel();
    await expect(ch.replyInThread('thread1', { channel: 'test', content: 'hi' })).rejects.toThrow();
  });

  it('getInfo should return channel info', () => {
    const ch = new BlueBubblesChannel();
    const info = ch.getInfo();
    expect(info.name).toBe('bluebubbles');
    expect(info.type).toBe('bluebubbles');
    expect(info.status).toBe('disconnected');
    expect(info.messageCount).toBe(0);
  });

  it('connected getter should return false initially', () => {
    const ch = new BlueBubblesChannel();
    expect(ch.connected).toBe(false);
  });
});

describe('Channel Message Types', () => {
  it('IncomingMessage should support thread field', () => {
    const mockThread: ThreadContext = {
      threadId: 'thread-123',
      channelId: 'channel-456',
      parentMessageId: 'msg-789',
      title: 'Test Thread',
    };

    const mockMessage: IncomingMessage = {
      id: 'msg-001',
      channel: 'test',
      conversationId: 'conv-001',
      sender: 'user-123',
      content: 'Hello from thread',
      timestamp: new Date().toISOString(),
      thread: mockThread,
    };

    expect(mockMessage.thread).toBeDefined();
    expect(mockMessage.thread?.threadId).toBe('thread-123');
    expect(mockMessage.thread?.channelId).toBe('channel-456');
  });

  it('OutgoingMessage should support threadId and replyTo', () => {
    const mockMessage: OutgoingMessage = {
      channel: 'test-channel',
      content: 'Reply in thread',
      threadId: 'thread-123',
      replyTo: 'msg-456',
    };

    expect(mockMessage.threadId).toBe('thread-123');
    expect(mockMessage.replyTo).toBe('msg-456');
  });
});
