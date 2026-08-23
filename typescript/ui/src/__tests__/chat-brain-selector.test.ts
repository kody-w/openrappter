// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../components/chat.js';
import { gateway } from '../services/gateway.js';
import { copilotReadiness } from '../services/copilot-readiness.js';

/**
 * Choosing which brain answers.
 *
 * The brainstem runs as its own process speaking HTTP, and the OpenRappter
 * runtime answers over the gateway. Holding one conversation across both used
 * to mean two chat windows side by side. They can share this one, because both
 * return the same §2.4 envelope.
 *
 * The risk that makes these tests worth writing: the two brains know different
 * things, and their replies are the same shape. An answer from the wrong brain
 * does not look wrong. So the selected target has to actually reach the wire,
 * and it has to survive a reload rather than silently reverting to the default.
 */

interface TestChatElement extends HTMLElement {
  chatTarget: 'openrappter' | 'brainstem';
  sessionKey: string | null;
  inputValue: string;
  sending: boolean;
  handleSend(): Promise<void>;
  handleTargetChange(event: Event): void;
  restoreChatTarget(): void;
}

function makeChat(): TestChatElement {
  return document.createElement('openrappter-chat') as TestChatElement;
}

/** A change event from a <select>, as the component receives it. */
function selectEvent(value: string): Event {
  const select = document.createElement('select');
  for (const option of ['openrappter', 'brainstem']) {
    const element = document.createElement('option');
    element.value = option;
    select.append(element);
  }
  select.value = value;
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: select });
  return event;
}

describe('chat brain selector', () => {
  beforeEach(() => {
    localStorage.clear();
    copilotReadiness.set({
      state: 'ready',
      message: 'Copilot is ready for this test.',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    copilotReadiness.set({
      state: 'unknown',
      message: 'Copilot readiness has not been checked.',
    });
  });

  it('talks to the local runtime unless told otherwise', () => {
    expect(makeChat().chatTarget).toBe('openrappter');
  });

  it('sends the selected target on the wire', async () => {
    const chat = makeChat();
    chat.chatTarget = 'brainstem';
    chat.sessionKey = 'session-1';
    chat.inputValue = 'who are you?';

    const request = vi
      .spyOn(gateway, 'request')
      .mockResolvedValue({ runId: 'run-1', sessionKey: 'session-1', status: 'accepted' } as never);

    await chat.handleSend();

    const [method, params] = request.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe('chat.send');
    // The whole feature is this parameter arriving; without it the brainstem
    // selection is decorative and the local runtime answers instead.
    expect(params.target).toBe('brainstem');
    expect(params.message).toBe('who are you?');
  });

  it('sends the local runtime as the target when that is selected', async () => {
    const chat = makeChat();
    chat.sessionKey = 'session-1';
    chat.inputValue = 'hello';

    const request = vi
      .spyOn(gateway, 'request')
      .mockResolvedValue({ runId: 'run-1', sessionKey: 'session-1', status: 'accepted' } as never);

    await chat.handleSend();

    const [, params] = request.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.target).toBe('openrappter');
  });

  it('remembers the choice across a reload', () => {
    const chat = makeChat();
    chat.handleTargetChange(selectEvent('brainstem'));
    expect(chat.chatTarget).toBe('brainstem');

    // A fresh element is what a reload produces.
    const reopened = makeChat();
    reopened.restoreChatTarget();
    expect(reopened.chatTarget).toBe('brainstem');
  });

  it('ignores a stored value that is not a brain', () => {
    localStorage.setItem('openrappter.chat.target', 'something-else');
    const chat = makeChat();
    chat.restoreChatTarget();
    expect(chat.chatTarget).toBe('openrappter');
  });

  it('ignores a change to an unknown target', () => {
    const chat = makeChat();
    chat.chatTarget = 'brainstem';
    chat.handleTargetChange(selectEvent('not-a-brain'));
    // Unchanged rather than reset: a bad event must not silently move the
    // conversation to the other brain.
    expect(chat.chatTarget).toBe('brainstem');
  });

  it('still switches when localStorage refuses to store', () => {
    const chat = makeChat();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    chat.handleTargetChange(selectEvent('brainstem'));

    // Private browsing or a full quota is not a reason to ignore the operator.
    expect(chat.chatTarget).toBe('brainstem');
  });
});
