// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../components/chat.js';
import { gateway } from '../services/gateway.js';

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
  chatTarget: 'openrappter' | 'brainstem' | 'estate';
  sessionKey: string | null;
  inputValue: string;
  sending: boolean;
  error: string | null;
  selectedEstateBuddyId: string;
  estateCreateDevice: string;
  estateCreateName: string;
  estateCreateRole: string;
  estateCreateUi: 'auto' | 'chat' | 'rapplication';
  estateCreateStatus: string;
  estateEvidenceFiles: File[];
  estateEvidenceSteering: string;
  messages: Array<{ role: string; content: string }>;
  handleSend(): Promise<void>;
  handleCreateEstateBuddy(event: Event): Promise<void>;
  loadEstateBuddies(): Promise<void>;
  handleAnalyzeEstateEvidence(): Promise<void>;
  handleTargetChange(event: Event): void;
  restoreChatTarget(): void;
}

function makeChat(): TestChatElement {
  return document.createElement('openrappter-chat') as TestChatElement;
}

/** A change event from a <select>, as the component receives it. */
function selectEvent(value: string): Event {
  const select = document.createElement('select');
  for (const option of ['openrappter', 'brainstem', 'estate']) {
    const element = document.createElement('option');
    element.value = option;
    select.append(element);
  }
  select.value = value;
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: select });
  return event;
}

const storageValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear() {
    storageValues.clear();
  },
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  key(index) {
    return [...storageValues.keys()][index] ?? null;
  },
  removeItem(key) {
    storageValues.delete(key);
  },
  setItem(key, value) {
    storageValues.set(key, String(value));
  },
};

describe('chat brain selector', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: testStorage,
    });
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    delete window.openrappterDesktop;
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

  it('chats with the selected estate Twin instead of the local runtime', async () => {
    const chat = makeChat();
    chat.chatTarget = 'estate';
    chat.selectedEstateBuddyId = 'barry';
    chat.inputValue = 'Are you alive?';

    const request = vi.spyOn(gateway, 'request').mockResolvedValue({
      ok: true,
      buddy: {
        id: 'barry',
        name: 'Barry',
        device: 'local-mac',
        rappid: null,
        presence: 'online',
        status: 'ready',
        transport: 'local',
        via_probe: false,
      },
      response: 'Barry READY',
      session_id: 'barry-session',
    } as never);

    await chat.handleSend();

    expect(request).toHaveBeenCalledWith(
      'estate.buddies.chat',
      {
        buddyId: 'barry',
        message: 'Are you alive?',
      },
      { timeoutMs: 10 * 60_000 },
    );
    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(chat.messages.at(-1)?.content).toBe('Barry READY');
    expect(chat.sending).toBe(false);
  });

  it('creates, verifies, refreshes, and selects a new estate Twin', async () => {
    const chat = makeChat();
    chat.chatTarget = 'estate';
    chat.estateCreateDevice = 'rappter-two';
    chat.estateCreateName = 'Map Maker';
    chat.estateCreateRole = 'Build a visual estate map.';
    chat.estateCreateUi = 'rapplication';

    const request = vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string) => {
        if (method === 'estate.buddies.create') {
          return {
            ok: true,
            device: 'rappter-two',
            presence: 'online',
            created: {
              name: 'Map Maker',
              rappid: 'rappid:@test/map-maker:' + 'a'.repeat(64),
              ui: 'rapplication',
            },
            handshake: { ready: true, response: 'Map Maker READY' },
          } as never;
        }
        return {
          ok: true,
          estate: 'Test Estate',
          devices: ['rappter-two'],
          buddies: [
            {
              id: 'old-map-maker',
              name: 'Map Maker',
              device: 'rappter-two',
              rappid: 'rappid:@test/map-maker:' + 'b'.repeat(64),
              presence: 'online',
              status: 'ready',
              transport: 'ssh-posix',
              via_probe: false,
              ui: 'rapplication',
            },
            {
              id: 'map-maker',
              name: 'Map Maker',
              device: 'rappter-two',
              rappid: 'rappid:@test/map-maker:' + 'a'.repeat(64),
              presence: 'online',
              status: 'ready',
              transport: 'ssh-posix',
              via_probe: false,
              ui: 'rapplication',
            },
          ],
        } as never;
      },
    );
    const submit = new Event('submit');
    vi.spyOn(submit, 'preventDefault');

    await chat.handleCreateEstateBuddy(submit);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'estate.buddies.create',
      'estate.buddies.list',
    ]);
    expect(request.mock.calls[0][1]).toEqual({
      deviceId: 'rappter-two',
      name: 'Map Maker',
      role: 'Build a visual estate map.',
      ui: 'rapplication',
    });
    expect(chat.selectedEstateBuddyId).toBe('map-maker');
    expect(chat.estateCreateStatus).toContain('online and ready');
    expect(chat.estateCreateStatus).toContain('default fallback');
  });

  it('does not create a buddy while an estate chat is in flight', async () => {
    const chat = makeChat();
    chat.sending = true;
    chat.estateCreateDevice = 'rappter-two';
    chat.estateCreateName = 'Racing Buddy';
    chat.estateCreateRole = 'Should not start.';
    const request = vi.spyOn(gateway, 'request');

    await chat.handleCreateEstateBuddy(new Event('submit'));

    expect(request).not.toHaveBeenCalled();
  });

  it('waits for an active roster load and refreshes again after creation', async () => {
    const chat = makeChat();
    chat.chatTarget = 'estate';
    chat.estateCreateDevice = 'rappter-two';
    chat.estateCreateName = 'Queued Creator';
    chat.estateCreateRole = 'Build a workflow.';
    let finishFirstLoad!: (value: unknown) => void;
    const firstLoad = new Promise((resolve) => {
      finishFirstLoad = resolve;
    });
    let listCalls = 0;
    const request = vi.spyOn(gateway, 'request').mockImplementation(
      async (method: string) => {
        if (method === 'estate.buddies.list' && ++listCalls === 1) {
          return firstLoad as never;
        }
        if (method === 'estate.buddies.create') {
          return {
            ok: true,
            device: 'rappter-two',
            presence: 'online',
            created: {
              name: 'Queued Creator',
              rappid: 'rappid:@test/queued:' + 'c'.repeat(64),
              ui: 'chat',
            },
            handshake: { ready: true, response: 'READY' },
          } as never;
        }
        return {
          ok: true,
          estate: 'Test Estate',
          devices: ['rappter-two'],
          buddies: [{
            id: 'queued',
            name: 'Queued Creator',
            device: 'rappter-two',
            rappid: 'rappid:@test/queued:' + 'c'.repeat(64),
            presence: 'online',
            status: 'ready',
            transport: 'ssh-posix',
            via_probe: false,
          }],
        } as never;
      },
    );

    const loading = chat.loadEstateBuddies();
    const creating = chat.handleCreateEstateBuddy(new Event('submit'));
    await Promise.resolve();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'estate.buddies.list',
    ]);

    finishFirstLoad({
      ok: true,
      estate: 'Test Estate',
      devices: ['rappter-two'],
      buddies: [],
    });
    await loading;
    await creating;

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'estate.buddies.list',
      'estate.buddies.create',
      'estate.buddies.list',
    ]);
    expect(chat.selectedEstateBuddyId).toBe('queued');
  });

  it('drafts the buddy name and role from locally extracted evidence', async () => {
    const chat = makeChat();
    chat.estateEvidenceFiles = [
      new File(['video-bytes'], 'invoice-walkthrough.mp4', {
        type: 'video/mp4',
      }),
    ];
    chat.estateEvidenceSteering = 'Keep final submission human-approved.';
    Object.defineProperty(window, 'openrappterDesktop', {
      configurable: true,
      value: {
        buddyEvidence: vi.fn().mockResolvedValue({
          schema: 'openrappter-buddy-evidence/1.0',
          filename: 'invoice-walkthrough.mp4',
          mimeType: 'video/mp4',
          kind: 'video',
          text: '[0s-5s] Open the invoice. [5s-10s] Verify and ask approval.',
          summary: 'Locally transcribed video walkthrough.',
          truncated: false,
        }),
      },
    });
    const request = vi.spyOn(gateway, 'request').mockResolvedValue({
      ok: true,
      schema: 'openrappter-estate-buddy-draft/1.0',
      name: 'Invoice Guide',
      role: 'Follow the demonstrated invoice steps and require approval.',
      ui: 'rapplication',
      evidenceSummary: 'An invoice workflow with an approval gate.',
      confidence: 'high',
      privacy: { masked: false, findings: [] },
      sourceFiles: [{
        filename: 'invoice-walkthrough.mp4',
        mimeType: 'video/mp4',
        kind: 'video',
      }],
    } as never);

    await chat.handleAnalyzeEstateEvidence();

    expect(request).toHaveBeenCalledWith(
      'estate.buddies.analyze',
      expect.objectContaining({
        evidenceText: expect.stringContaining('Open the invoice'),
        steering: 'Keep final submission human-approved.',
      }),
      { timeoutMs: 10 * 60_000 },
    );
    expect(chat.estateCreateName).toBe('Invoice Guide');
    expect(chat.estateCreateRole).toContain('require approval');
    expect(chat.estateCreateUi).toBe('rapplication');
    expect(chat.estateCreateStatus).toContain('high confidence');

    request.mockClear();
    chat.estateCreateDevice = 'local-mac';
    chat.estateEvidenceSteering = 'Changed after analysis.';
    await chat.handleCreateEstateBuddy(new Event('submit'));
    expect(request).not.toHaveBeenCalled();
    expect(chat.error).toContain('Analyze the current evidence');
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

  it('restores the estate target across a reload', () => {
    localStorage.setItem('openrappter.chat.target', 'estate');
    const reopened = makeChat();
    reopened.restoreChatTarget();
    expect(reopened.chatTarget).toBe('estate');
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
