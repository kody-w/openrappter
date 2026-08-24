// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../components/chat.js';
import { gateway } from '../services/gateway.js';

interface TestChatElement extends HTMLElement {
  updateComplete: Promise<boolean>;
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
    commitState?: 'pending' | 'committed' | 'cancelled' | 'error';
  }>;
  handleChatEvent(payload: unknown): void;
  armRunDeadline(runId: string): void;
  startNewChat(): Promise<void>;
  switchSession(sessionId: string): Promise<void>;
  handleSend(): Promise<void>;
}

async function settle(element: TestChatElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('chat component terminal events', () => {
  afterEach(() => {
    document.body.replaceChildren();
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
        commitState: 'pending',
      },
      {
        id: 'current-run',
        role: 'assistant',
        content: '',
        timestamp: 2,
        streaming: true,
        commitState: 'pending',
      },
    ];

    chat.handleChatEvent({
      runId: 'stale-run',
      sessionKey: 'session-1',
      state: 'aborted',
    });
    expect(chat.messages[0].streaming).toBe(false);
    expect(chat.messages[0].commitState).toBe('cancelled');
    expect(chat.messages[1].streaming).toBe(true);
    expect(chat.activeRunId).toBe('current-run');
    expect(chat.sending).toBe(true);

    chat.handleChatEvent({
      runId: 'current-run',
      sessionKey: 'session-1',
      state: 'aborted',
    });
    expect(chat.messages[1].streaming).toBe(false);
    expect(chat.messages[1].commitState).toBe('cancelled');
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

  it('buffers deltas off-screen and atomically commits the final message', () => {
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.activeRunId = 'run-1';
    chat.sessionKey = 'session-1';
    chat.sending = true;
    chat.messages = [{
      id: 'run-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
      commitState: 'pending',
    }];

    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'delta',
      message: { content: [{ type: 'text', text: 'half ' }] },
    });
    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'delta',
      message: { content: [{ type: 'text', text: 'sentence' }] },
    });

    expect(chat.messages[0].content).toBe('');
    expect(chat.messages[0].commitState).toBe('pending');

    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'final',
      message: { content: [{ type: 'text', text: 'Complete answer.' }] },
    });

    expect(chat.messages[0].content).toBe('Complete answer.');
    expect(chat.messages[0].streaming).toBe(false);
    expect(chat.messages[0].commitState).toBe('committed');
  });

  it('uses a buffered response only when the final event omits duplicate text', () => {
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.activeRunId = 'run-1';
    chat.sessionKey = 'session-1';
    chat.sending = true;
    chat.messages = [{
      id: 'run-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
      commitState: 'pending',
    }];

    for (const text of ['Complete ', 'answer.']) {
      chat.handleChatEvent({
        runId: 'run-1',
        sessionKey: 'session-1',
        state: 'delta',
        message: { content: [{ type: 'text', text }] },
      });
    }
    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'final',
    });

    expect(chat.messages[0].content).toBe('Complete answer.');
    expect(chat.messages[0].commitState).toBe('committed');
  });

  it('renders presence instead of partial language, then one committed bubble', async () => {
    vi.spyOn(gateway, 'call').mockResolvedValue([]);
    const chat = document.createElement('openrappter-chat') as TestChatElement;
    chat.activeRunId = 'run-1';
    chat.sessionKey = 'session-1';
    chat.sending = true;
    chat.messages = [{
      id: 'run-1',
      role: 'assistant',
      content: '',
      timestamp: 1,
      streaming: true,
      commitState: 'pending',
    }];
    document.body.append(chat);
    await settle(chat);

    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'delta',
      message: { content: [{ type: 'text', text: 'unfinished thought' }] },
    });
    await settle(chat);

    const pendingText = chat.shadowRoot?.textContent ?? '';
    expect(pendingText).toContain('RAPPID is responding');
    expect(pendingText).not.toContain('unfinished thought');
    expect(chat.shadowRoot?.querySelector('[role="status"]')).toBeTruthy();

    chat.handleChatEvent({
      runId: 'run-1',
      sessionKey: 'session-1',
      state: 'final',
      message: { content: [{ type: 'text', text: '**Complete answer.**' }] },
    });
    await settle(chat);

    expect(chat.shadowRoot?.textContent).toContain('Complete answer.');
    expect(chat.shadowRoot?.textContent).not.toContain('RAPPID is responding');
    expect(chat.shadowRoot?.querySelector('.message.assistant.committed strong'))
      .toBeTruthy();
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
