/**
 * Channel Registry Parity Tests
 *
 * Exercises the real ChannelRegistry (src/channels/registry.ts) and the
 * credential-redaction path in BaseChannel.getConfig (src/channels/base.ts).
 * The previous version of this file imported only `vitest`, mocked four channel
 * classes and then never used the mocks, and asserted on hand-built literals —
 * its "Channel Registry" section even reimplemented the registry with a local
 * `new Map()` instead of touching the product. It passed no matter what the
 * channel layer did.
 *
 * Registration + connectAll/disconnectAll + sendMessage routing + onMessage +
 * getStatusList are already covered by parity/showcase-channel-switchboard.test.ts,
 * and individual transports by src/channels/*.test.ts. This file deliberately
 * covers the complementary, previously-unpinned surface: lookup by type OR name
 * (findByType), unregister/has/clear/size, probeChannel, and — most importantly —
 * that configureChannel round-trips through getChannelConfig with secrets
 * redacted rather than echoed back in the clear.
 */

import { describe, it, expect } from 'vitest';
import { BaseChannel } from '../../channels/base.js';
import { ChannelRegistry } from '../../channels/registry.js';
import type { OutgoingMessage } from '../../channels/types.js';

/** Minimal concrete channel: a real BaseChannel subclass with a config bag. */
class TestChannel extends BaseChannel {
  config: Record<string, unknown>;

  constructor(name: string, type: string, config: Record<string, unknown> = {}) {
    super(name, type);
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(_conversationId: string, _message: OutgoingMessage): Promise<void> {
    // no-op: routing is covered by showcase-channel-switchboard
  }

  getConfigFields() {
    return [{ key: 'token', label: 'Bot Token', type: 'password' as const, required: true }];
  }
}

describe('Channel Registry Parity', () => {
  describe('Registration lifecycle', () => {
    it('registers, finds, and unregisters a channel by name', () => {
      const reg = new ChannelRegistry();
      reg.register(new TestChannel('discord-main', 'discord'));

      expect(reg.has('discord-main')).toBe(true);
      expect(reg.get('discord-main')?.type).toBe('discord');
      expect(reg.names()).toEqual(['discord-main']);
      expect(reg.size).toBe(1);

      expect(reg.unregister('discord-main')).toBe(true);
      expect(reg.unregister('discord-main')).toBe(false); // already gone
      expect(reg.has('discord-main')).toBe(false);
    });

    it('clear() removes every registered channel', () => {
      const reg = new ChannelRegistry();
      reg.register(new TestChannel('a', 'slack'));
      reg.register(new TestChannel('b', 'telegram'));
      expect(reg.size).toBe(2);

      reg.clear();
      expect(reg.size).toBe(0);
      expect(reg.list()).toHaveLength(0);
    });
  });

  describe('Lookup by type or name', () => {
    it('resolves a channel by its type, not only its name', async () => {
      const reg = new ChannelRegistry();
      reg.register(new TestChannel('primary-slack', 'slack')); // name != type

      await reg.connectChannel('slack'); // resolved by type
      expect(reg.get('primary-slack')?.connected).toBe(true);

      await reg.disconnectChannel('primary-slack'); // resolved by name
      expect(reg.get('primary-slack')?.connected).toBe(false);
    });

    it('throws when acting on a channel that is not registered', async () => {
      const reg = new ChannelRegistry();
      await expect(reg.connectChannel('ghost')).rejects.toThrow(/not registered/);
    });
  });

  describe('probeChannel', () => {
    it('reports not-connected until the channel connects', async () => {
      const reg = new ChannelRegistry();
      reg.register(new TestChannel('tel', 'telegram'));

      expect(await reg.probeChannel('telegram')).toEqual({ ok: false, error: 'Not connected' });

      await reg.connectChannel('telegram');
      const probe = await reg.probeChannel('telegram');
      expect(probe.ok).toBe(true);
      expect(probe.error).toBeUndefined();
    });

    it('reports an unregistered channel as not ok', async () => {
      const reg = new ChannelRegistry();
      const probe = await reg.probeChannel('missing');
      expect(probe.ok).toBe(false);
      expect(probe.error).toContain('not registered');
    });
  });

  describe('Configuration round-trip with credential redaction', () => {
    it('stores config via configureChannel and redacts secrets on read-back', () => {
      const reg = new ChannelRegistry();
      reg.register(new TestChannel('tg', 'telegram', {}));

      reg.configureChannel('telegram', { token: 'secret-1234567890', botName: 'helper' });

      const { config, fields } = reg.getChannelConfig('telegram');

      // Non-secret values survive verbatim.
      expect(config.botName).toBe('helper');
      // The token must NOT be echoed back in the clear.
      expect(config.token).not.toBe('secret-1234567890');
      expect(config.token).not.toContain('7890'); // tail is hidden
      expect(String(config.token)).toContain('\u2022'); // bullet redaction
      expect(String(config.token).startsWith('secr')).toBe(true); // 4-char prefix kept
      // Field definitions flow through for UI rendering.
      expect(fields).toEqual([{ key: 'token', label: 'Bot Token', type: 'password', required: true }]);
    });

    it('throws when configuring or reading an unregistered channel', () => {
      const reg = new ChannelRegistry();
      expect(() => reg.configureChannel('nope', { token: 'x' })).toThrow(/not registered/);
      expect(() => reg.getChannelConfig('nope')).toThrow(/not registered/);
    });
  });
});
