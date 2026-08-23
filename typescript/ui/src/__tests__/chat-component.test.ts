// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../components/chat.js';
import { gateway } from '../services/gateway.js';
import { copilotReadiness } from '../services/copilot-readiness.js';

interface TestChatElement extends HTMLElement {
  activeRunId: string | null;
  sessionKey: string | null;
  sending: boolean;
  error: string | null;
  inputValue: string;
  messages: Array<{
    id: string;
    role: 'assistant';
    content: string;
    timestamp: number;
    streaming: boolean;
  }>;
  handleChatEvent(payload: unknown): void;
  armRunDeadline(runId: string): void;
  startNewChat(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  handleSend(): Promise<void>;
}

describe('chat component terminal events', () => {
  beforeEach(() => {
    copilotReadiness.set({
      state: 'ready',
      message: 'Copilot is ready for this test.',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    copilotReadiness.set({
      state: 'unknown',
      message: 'Copilot readiness has not been checked.',
    });
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

  it('aborts and fences the active run before starting a new chat', async () => {
    const abort = vi.spyOn(gateway, 'request').mockResolvedValue({
      aborted: true,
    });
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.sessionKey = 'session-1';
    chat.activeRunId = 'run-1';
    chat.sending = true;
    chat.messages = [{
      id: 'run-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
    }];

    await chat.startNewChat();

    expect(abort).toHaveBeenCalledWith(
      'chat.abort',
      { runId: 'run-1' },
      { timeoutMs: 5_000 },
    );
    expect(chat.sessionKey).toBeNull();
    expect(chat.activeRunId).toBeNull();
    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'final',
      message: { content: [{ type: 'text', text: 'late result' }] },
    });
    expect(chat.messages).toEqual([]);
  });

  it('fences a pending send response when the user switches sessions', async () => {
    let finishSend!: (value: {
      runId: string;
      sessionKey: string;
      status: string;
    }) => void;
    const send = new Promise<{
      runId: string;
      sessionKey: string;
      status: string;
    }>((resolve) => {
      finishSend = resolve;
    });

    const request = vi.spyOn(gateway, 'request').mockImplementation(
      async (method) => {
        if (method === 'chat.send') return send;
        return { aborted: true };
      },
    );
    vi.spyOn(gateway, 'call').mockResolvedValue([]);
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.sessionKey = 'session-1';
    chat.activeRunId = null;
    chat.sending = false;
    chat.error = null;
    chat.inputValue = 'hello';
    chat.messages = [];

    const sending = chat.handleSend();
    await Promise.resolve();
    const switching = chat.switchSession('session-2');
    finishSend({ runId: 'run-1', sessionKey: 'session-1', status: 'started' });
    await sending;
    await switching;

    expect(chat.sessionKey).toBe('session-2');
    expect(chat.activeRunId).toBeNull();
    expect(chat.messages).toEqual([]);
    expect(request).toHaveBeenCalledWith(
      'chat.abort',
      { runId: 'run-1' },
      { timeoutMs: 5_000 },
    );
  });

  it('blocks a new send while a session transition is aborting', async () => {
    let finishAbort!: () => void;
    const aborting = new Promise<void>((resolve) => {
      finishAbort = resolve;
    });
    const request = vi.spyOn(gateway, 'request').mockImplementation(
      async (method) => {
        if (method === 'chat.abort') {
          await aborting;
          return { aborted: true };
        }
        return { runId: 'unexpected', sessionKey: 'session-1', status: 'started' };
      },
    );
    vi.spyOn(gateway, 'call').mockResolvedValue([]);
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.sessionKey = 'session-1';
    chat.activeRunId = 'run-1';
    chat.sending = true;
    chat.error = null;
    chat.inputValue = '';
    chat.messages = [{
      id: 'run-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
    }];

    const switching = chat.switchSession('session-2');
    await Promise.resolve();
    chat.inputValue = 'must not send';
    await chat.handleSend();
    expect(
      request.mock.calls.filter(([method]) => method === 'chat.send'),
    ).toHaveLength(0);
    finishAbort();
    await switching;
    expect(chat.sessionKey).toBe('session-2');
  });
});
