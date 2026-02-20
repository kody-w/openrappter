/**
 * Tests for slash commands — /new and /reset.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseSlashCommand, executeSlashCommand } from './slash-commands.js';

// ── Mock gateway client ───────────────────────────────────────────────────────

function makeMockClient() {
  return {
    call: vi.fn(async () => ({})),
    connected: true,
    connect: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as Parameters<typeof executeSlashCommand>[1] extends infer C ? C : never;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Slash Commands', () => {
  describe('parseSlashCommand()', () => {
    it('/new parses correctly', () => {
      const result = parseSlashCommand('/new');
      expect(result).toEqual({ command: 'new', args: '' });
    });

    it('/reset parses correctly', () => {
      const result = parseSlashCommand('/reset');
      expect(result).toEqual({ command: 'reset', args: '' });
    });
  });

  describe('/new command', () => {
    it('sends greeting prompt via client.call("chat.send")', async () => {
      const client = makeMockClient();
      const { result } = await executeSlashCommand('/new', client as never);

      expect(client.call).toHaveBeenCalledWith('chat.send', {
        message: expect.stringContaining('new session was started'),
      });
      expect(result).toBeNull();
    });
  });

  describe('/reset command', () => {
    it('sends greeting prompt via client.call("chat.send")', async () => {
      const client = makeMockClient();
      const { result } = await executeSlashCommand('/reset', client as never);

      expect(client.call).toHaveBeenCalledWith('chat.send', {
        message: expect.stringContaining('new session was started'),
      });
      expect(result).toBeNull();
    });
  });
});
