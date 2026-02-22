/**
 * Showcase: Channel Switchboard
 *
 * Tests ChannelRegistry: register, connect, route, handler, status, disconnect.
 * Uses MockChannel extending BaseChannel.
 */

import { describe, it, expect } from 'vitest';
import { BaseChannel } from '../../channels/base.js';
import { ChannelRegistry } from '../../channels/registry.js';
import type { IncomingMessage, OutgoingMessage } from '../../channels/types.js';

// ── Mock channel ──

class MockChannel extends BaseChannel {
  sentMessages: Array<{ conversationId: string; message: OutgoingMessage }> = [];

  constructor(name: string) {
    super(name, name);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    this.sentMessages.push({ conversationId, message });
  }

  // Expose emitMessage for testing
  async triggerMessage(message: IncomingMessage): Promise<void> {
    await this.emitMessage(message);
  }
}

describe('Showcase: Channel Switchboard', () => {
  describe('Registration', () => {
    it('should register multiple channels and list names', () => {
      const registry = new ChannelRegistry();
      registry.register(new MockChannel('slack'));
      registry.register(new MockChannel('discord'));
      registry.register(new MockChannel('telegram'));

      expect(registry.names()).toEqual(expect.arrayContaining(['slack', 'discord', 'telegram']));
      expect(registry.size).toBe(3);
    });

    it('should get channel by name', () => {
      const registry = new ChannelRegistry();
      const slack = new MockChannel('slack');
      registry.register(slack);

      expect(registry.get('slack')).toBe(slack);
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('Connection', () => {
    it('should connectAll() setting connected = true on all channels', async () => {
      const registry = new ChannelRegistry();
      const slack = new MockChannel('slack');
      const discord = new MockChannel('discord');
      registry.register(slack);
      registry.register(discord);

      await registry.connectAll();

      expect(slack.connected).toBe(true);
      expect(discord.connected).toBe(true);
    });

    it('should disconnectAll() disconnecting all channels', async () => {
      const registry = new ChannelRegistry();
      const slack = new MockChannel('slack');
      const discord = new MockChannel('discord');
      registry.register(slack);
      registry.register(discord);

      await registry.connectAll();
      await registry.disconnectAll();

      expect(slack.connected).toBe(false);
      expect(discord.connected).toBe(false);
    });
  });

  describe('Message routing', () => {
    it('should sendMessage() routing to correct channel', async () => {
      const registry = new ChannelRegistry();
      const slack = new MockChannel('slack');
      const discord = new MockChannel('discord');
      registry.register(slack);
      registry.register(discord);

      await registry.sendMessage({
        channelId: 'slack',
        conversationId: 'C123',
        content: 'Hello from test',
      });

      expect(slack.sentMessages.length).toBe(1);
      expect(slack.sentMessages[0].conversationId).toBe('C123');
      expect(slack.sentMessages[0].message.content).toBe('Hello from test');
      expect(discord.sentMessages.length).toBe(0);
    });

    it('should fire onMessage handler on emitMessage', async () => {
      const channel = new MockChannel('slack');
      const received: IncomingMessage[] = [];
      channel.onMessage(async (msg) => { received.push(msg); });

      const message: IncomingMessage = {
        id: 'msg_1',
        channel: 'slack',
        sender: 'user1',
        content: 'hello',
        timestamp: new Date().toISOString(),
      };
      await channel.triggerMessage(message);

      expect(received.length).toBe(1);
      expect(received[0].content).toBe('hello');
    });
  });

  describe('Status tracking', () => {
    it('should report status list with connection state', async () => {
      const registry = new ChannelRegistry();
      const slack = new MockChannel('slack');
      const discord = new MockChannel('discord');
      registry.register(slack);
      registry.register(discord);

      await slack.connect();

      const statuses = registry.getStatusList();
      expect(statuses.length).toBe(2);

      const slackStatus = statuses.find(s => s.id === 'slack');
      expect(slackStatus?.connected).toBe(true);

      const discordStatus = statuses.find(s => s.id === 'discord');
      expect(discordStatus?.connected).toBe(false);
    });
  });
});
