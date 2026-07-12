// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../components/chat.js';
import { gateway } from '../services/gateway.js';

interface TestChatElement extends HTMLElement {
  activeRunId: string | null;
  sending: boolean;
  error: string | null;
  messages: Array<{
    id: string;
    role: 'assistant';
    content: string;
    timestamp: number;
    streaming: boolean;
  }>;
  handleChatEvent(payload: unknown): void;
  armRunDeadline(runId: string): void;
}

describe('chat component terminal events', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears only the matching stream when aborted remotely or by supersession', () => {
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.activeRunId = 'current-run';
    chat.sending = true;
    chat.messages = [
      {
        id: 'stale-run',
        role: 'assistant',
        content: '',
        timestamp: 1,
        streaming: true,
      },
      {
        id: 'current-run',
        role: 'assistant',
        content: '',
        timestamp: 2,
        streaming: true,
      },
    ];

    chat.handleChatEvent({
      runId: 'stale-run',
      sessionKey: 'session-1',
      state: 'aborted',
    });
    expect(chat.messages[0].streaming).toBe(false);
    expect(chat.messages[1].streaming).toBe(true);
    expect(chat.activeRunId).toBe('current-run');
    expect(chat.sending).toBe(true);

    chat.handleChatEvent({
      runId: 'current-run',
      sessionKey: 'session-1',
      state: 'aborted',
    });
    expect(chat.messages[1].streaming).toBe(false);
    expect(chat.activeRunId).toBeNull();
    expect(chat.sending).toBe(false);

    chat.handleChatEvent({
      runId: 'current-run',
      sessionKey: 'session-1',
      state: 'final',
      message: { content: [{ type: 'text', text: 'late result' }] },
    });
    expect(chat.messages[1].content).toBe('');
  });

  it('cancels a run at the bounded overall deadline', async () => {
    vi.useFakeTimers();
    const abort = vi.spyOn(gateway, 'request').mockResolvedValue({ aborted: true });
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.activeRunId = 'long-run';
    chat.sending = true;
    chat.error = null;
    chat.messages = [{
      id: 'long-run',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
    }];

    chat.armRunDeadline('long-run');
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(abort).toHaveBeenCalledWith(
      'chat.abort',
      { runId: 'long-run' },
      { timeoutMs: 5_000 },
    );
    expect(chat.activeRunId).toBeNull();
    expect(chat.sending).toBe(false);
    expect(chat.messages[0].streaming).toBe(false);
    expect(chat.error).toContain('cancelled');
  });
});
