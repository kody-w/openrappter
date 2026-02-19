import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commands, parseSlashCommand, executeSlashCommand } from '../../tui/slash-commands.js';

function createMockClient(responses: Record<string, unknown> = {}) {
  return {
    call: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method in responses) return responses[method];
      throw new Error(`No mock for ${method}`);
    }),
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  } as any;
}

describe('/channels command', () => {
  it('should exist in slash commands registry', () => {
    const channelsCmd = commands.find(c => c.name === 'channels');
    expect(channelsCmd).toBeDefined();
    expect(channelsCmd!.description).toBeTruthy();
  });

  it('should list channels from gateway', async () => {
    const client = createMockClient({
      'channels.list': [
        { id: 'cli-1', type: 'cli', connected: true, configured: true, running: true, messageCount: 42 },
        { id: 'tg-1', type: 'telegram', connected: false, configured: false, running: false, messageCount: 0 },
      ],
    });

    const { result } = await executeSlashCommand('/channels', client);
    expect(result).toContain('cli');
    expect(result).toContain('connected');
    expect(result).toContain('telegram');
    expect(result).toContain('not configured');
  });

  it('should identify unconfigured channels and suggest setup', async () => {
    const client = createMockClient({
      'channels.list': [
        { id: 'tg-1', type: 'telegram', connected: false, configured: false, running: false, messageCount: 0 },
      ],
    });

    const { result } = await executeSlashCommand('/channels', client);
    expect(result).toContain('/channel-setup');
  });

  it('should handle empty channels list', async () => {
    const client = createMockClient({ 'channels.list': [] });
    const { result } = await executeSlashCommand('/channels', client);
    expect(result).toContain('No channels available');
  });

  it('should handle gateway errors gracefully', async () => {
    const client = createMockClient({}); // No mock = throws
    const { result } = await executeSlashCommand('/channels', client);
    expect(result).toContain('Failed to list channels');
  });
});

describe('/channel-setup command', () => {
  it('should show required fields for a channel type', async () => {
    const client = createMockClient({
      'channels.getConfig': [
        { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', type: 'string', required: true },
        { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID', type: 'string', required: false },
      ],
    });

    const { result } = await executeSlashCommand('/channel-setup telegram', client);
    expect(result).toContain('Bot Token');
    expect(result).toContain('required');
    expect(result).toContain('/channel-set');
  });

  it('should show usage when no type given', async () => {
    const client = createMockClient({});
    const { result } = await executeSlashCommand('/channel-setup', client);
    expect(result).toContain('Usage');
  });
});

describe('/channel-set command', () => {
  it('should send configure call with correct payload', async () => {
    const client = createMockClient({ 'channels.configure': { ok: true } });

    const { result } = await executeSlashCommand('/channel-set telegram TELEGRAM_BOT_TOKEN abc123', client);
    expect(client.call).toHaveBeenCalledWith('channels.configure', {
      type: 'telegram',
      config: { TELEGRAM_BOT_TOKEN: 'abc123' },
    });
    expect(result).toContain('saved');
  });

  it('should show usage when insufficient args', async () => {
    const client = createMockClient({});
    const { result } = await executeSlashCommand('/channel-set telegram', client);
    expect(result).toContain('Usage');
  });
});

describe('/channel-connect command', () => {
  it('should call channels.connect with the type', async () => {
    const client = createMockClient({ 'channels.connect': { ok: true } });
    const { result } = await executeSlashCommand('/channel-connect telegram', client);
    expect(client.call).toHaveBeenCalledWith('channels.connect', { type: 'telegram' });
    expect(result).toContain('connected successfully');
  });

  it('should handle connection errors', async () => {
    const client = createMockClient({});
    const { result } = await executeSlashCommand('/channel-connect telegram', client);
    expect(result).toContain('Failed to connect');
  });
});
