/**
 * MessageAgent — iMessage direct send tests
 *
 * Tests the iMessage send pathway: allowed contacts, rate limiting,
 * recipient alias, and AppleScript dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageAgent } from '../../agents/MessageAgent.js';

// Mock child_process.exec so we never actually call osascript
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(null, { stdout: '', stderr: '' });
    return { on: vi.fn(), stdout: null, stderr: null };
  }),
}));

vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util');
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  };
});

describe('MessageAgent — iMessage direct send', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Simulate macOS
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    // Clean iMessage env vars
    delete process.env.IMESSAGE_ALLOWED_CONTACTS;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env = { ...originalEnv };
  });

  it('rejects send when no allowed contacts configured', async () => {
    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'rappter1@icloud.com',
      content: 'hello',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('No allowed iMessage contacts');
  });

  it('rejects send when recipient is not in allowed list', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'alice@icloud.com, bob@icloud.com';
    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'eve@icloud.com',
      content: 'hello',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('not in the allowed contacts list');
    expect(parsed.message).toContain('alice@icloud.com');
  });

  it('allowed contacts check is case-insensitive', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'Rappter1@iCloud.com';
    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'rappter1@icloud.com',
      content: 'hello',
    });
    const parsed = JSON.parse(result);
    // Should not fail on the allowlist check (may fail on osascript, that's fine)
    expect(parsed.message).not.toContain('not in the allowed contacts list');
  });

  it('accepts "imsg" as a channel alias', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';
    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imsg',
      recipient: 'test@icloud.com',
      content: 'hello',
    });
    const parsed = JSON.parse(result);
    // Should reach the iMessage path (not "channel not found")
    expect(parsed.message).not.toContain('Channel not found');
  });

  it('recipient param is an alias for conversationId', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';
    const agent = new MessageAgent();

    // Use conversationId instead of recipient
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      conversationId: 'test@icloud.com',
      content: 'hello via conversationId',
    });
    const parsed = JSON.parse(result);
    expect(parsed.message).not.toContain('conversationId, and content required');
  });

  it('rate limits after max messages', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';
    const agent = new MessageAgent();

    // Fill up rate limiter by manipulating internal state
    const now = Date.now();
    // @ts-expect-error accessing private for testing
    agent.iMessageSendTimes = Array(10).fill(now);

    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'test@icloud.com',
      content: 'one too many',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('Rate limit');
  });

  it('expired rate limit entries are pruned', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';
    const agent = new MessageAgent();

    // All entries older than 1 hour — should be pruned
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    // @ts-expect-error accessing private for testing
    agent.iMessageSendTimes = Array(10).fill(twoHoursAgo);

    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'test@icloud.com',
      content: 'should work',
    });
    const parsed = JSON.parse(result);
    // Should NOT hit rate limit (old entries pruned)
    expect(parsed.message).not.toContain('Rate limit');
  });

  it('rejects on non-macOS platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';

    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      recipient: 'test@icloud.com',
      content: 'hello',
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('only available on macOS');
  });

  it('lists iMessage in available channels when configured', async () => {
    process.env.IMESSAGE_ALLOWED_CONTACTS = 'test@icloud.com';
    const agent = new MessageAgent();
    const result = await agent.execute({ action: 'list_channels' });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('success');
    const ids = parsed.channels.map((c: { id: string }) => c.id);
    expect(ids).toContain('imessage');
  });

  it('does not list iMessage when not configured', async () => {
    delete process.env.IMESSAGE_ALLOWED_CONTACTS;
    const agent = new MessageAgent();
    const result = await agent.execute({ action: 'list_channels' });
    const parsed = JSON.parse(result);
    const ids = parsed.channels.map((c: { id: string }) => c.id);
    expect(ids).not.toContain('imessage');
  });

  it('metadata description mentions iMessage', () => {
    const agent = new MessageAgent();
    expect(agent.metadata.description).toContain('iMessage');
    expect(agent.metadata.description).toContain('recipient');
  });

  it('requires action parameter', async () => {
    const agent = new MessageAgent();
    const result = await agent.execute({});
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('No action specified');
  });

  it('requires all send parameters', async () => {
    const agent = new MessageAgent();
    const result = await agent.execute({
      action: 'send',
      channelId: 'imessage',
      // missing recipient and content
    });
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('error');
    expect(parsed.message).toContain('required for send action');
  });
});
