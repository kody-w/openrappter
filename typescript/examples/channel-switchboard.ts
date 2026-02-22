/**
 * Channel Switchboard — ChannelRegistry routing and status
 *
 * Run: npx tsx examples/channel-switchboard.ts
 */

import { BaseChannel } from '../src/channels/base.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import type { IncomingMessage, OutgoingMessage } from '../src/channels/types.js';

class MockChannel extends BaseChannel {
  sentMessages: Array<{ conversationId: string; message: OutgoingMessage }> = [];

  constructor(name: string) {
    super(name, name);
  }

  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    this.sentMessages.push({ conversationId, message });
  }
}

async function main() {
  console.log('=== Channel Switchboard ===\n');

  const registry = new ChannelRegistry();
  const slack = new MockChannel('slack');
  const discord = new MockChannel('discord');
  const telegram = new MockChannel('telegram');

  // Step 1: Register + connect
  console.log('Step 1: Register and connect channels...');
  registry.register(slack);
  registry.register(discord);
  registry.register(telegram);
  await registry.connectAll();
  console.log(`  Channels: ${registry.names().join(', ')}`);
  console.log(`  All connected: ${registry.list().every(ch => ch.connected)}\n`);

  // Step 2: Route messages
  console.log('Step 2: Route messages...');
  await registry.sendMessage({ channelId: 'slack', conversationId: 'C123', content: 'Alert!' });
  await registry.sendMessage({ channelId: 'discord', conversationId: 'D456', content: 'Update!' });
  console.log(`  Slack msgs: ${slack.sentMessages.length}`);
  console.log(`  Discord msgs: ${discord.sentMessages.length}\n`);

  // Step 3: Status + disconnect
  console.log('Step 3: Probe and disconnect...');
  const statuses = registry.getStatusList();
  for (const s of statuses) {
    console.log(`  ${s.id}: connected=${s.connected}`);
  }
  await registry.disconnectAll();
  console.log(`  After disconnect: ${registry.list().every(ch => !ch.connected)}`);
}

main().catch(console.error);
