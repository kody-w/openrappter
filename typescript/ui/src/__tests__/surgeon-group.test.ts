// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurgeonPatientSnapshot } from '../types.js';

const IDS = [
  `rappid:@openrappter/ui-a:${'a'.repeat(64)}`,
  `rappid:@openrappter/ui-b:${'b'.repeat(64)}`,
  `rappid:@openrappter/ui-c:${'c'.repeat(64)}`,
] as const;

const mocks = vi.hoisted(() => ({
  loadPatient: vi.fn(),
  loadCases: vi.fn(),
  sendTurn: vi.fn(),
  approveProcedure: vi.fn(),
  rejectProcedure: vi.fn(),
  operate: vi.fn(),
  loadSurgeonFeatures: vi.fn(),
  loadGroupParticipants: vi.fn(),
  createGroup: vi.fn(),
  sendGroupTurn: vi.fn(),
  cancelGroup: vi.fn(),
}));

vi.mock('../services/surgeon.js', () => mocks);

import '../components/surgeon.js';

interface SurgeonElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const patient: SurgeonPatientSnapshot = {
  capturedAt: '2026-08-30T20:00:00.000Z',
  patient: 'OpenRappter',
  version: '1.13.0',
  state: 'stable',
  uptimeSeconds: 100,
  tissues: [],
  inventory: {
    agents: [],
    channels: [],
    scheduledJobs: [],
  },
  metrics: {
    connections: 1,
    agents: 0,
    configuredChannels: 0,
    connectedChannels: 0,
    scheduledJobs: 0,
    activeCases: 0,
  },
};

const participants = IDS.map((rappid, index) => ({
  rappid,
  liveId: `rapp-${900 + index}-${String(index + 1).repeat(16)}`,
  pid: 900 + index,
  state: 'active' as const,
  isDefault: index === 0,
  featureEnabled: true,
  liveLabel: `rapp-${900 + index}-${String(index + 1).repeat(16)} · harness-${index + 1}`,
  metadata: {
    aliases: [`p${index + 1}`],
    harness: `harness-${index + 1}`,
    endpoint: `http://127.0.0.1:${9900 + index}`,
    port: 9900 + index,
  },
}));

async function settle(element: SurgeonElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('Brain Surgeon group mode feature gate', () => {
  beforeEach(() => {
    mocks.loadPatient.mockResolvedValue(patient);
    mocks.loadCases.mockResolvedValue([]);
    mocks.loadSurgeonFeatures.mockResolvedValue({
      brainSurgeonGroupChat: false,
    });
    mocks.loadGroupParticipants.mockResolvedValue({ participants });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('keeps the default surface limited to Surgeon and Patient', async () => {
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    const toolbar = element.shadowRoot?.querySelector('[aria-label="Who you are talking to"]');
    expect(Array.from(toolbar?.querySelectorAll('button') ?? []).map(button =>
      button.textContent?.trim())).toEqual(['⌘ Surgeon', '🦖 Patient']);
    const text = element.shadowRoot?.textContent ?? '';
    for (const absent of ['Group', 'Participants', 'Runtime', 'PID', 'RAPPID', 'Hermes', 'Pi']) {
      expect(text).not.toContain(absent);
    }
    expect(mocks.loadGroupParticipants).not.toHaveBeenCalled();
  });

  it('renders accessible stable-keyed participant controls only when enabled', async () => {
    mocks.loadSurgeonFeatures.mockResolvedValue({
      brainSurgeonGroupChat: true,
    });
    mocks.createGroup.mockResolvedValue({
      id: 'ui-group',
      participants: participants.map(participant => ({
        rappid: participant.rappid,
        liveId: participant.liveId,
        liveLabel: participant.liveLabel,
        harness: participant.metadata.harness,
      })),
      rounds: 1,
      state: 'ready',
      createdAt: '2026-08-30T20:00:00.000Z',
      updatedAt: '2026-08-30T20:00:00.000Z',
      transcriptLength: 0,
    });
    mocks.sendGroupTurn.mockResolvedValue({
      id: 'ui-group',
      participants: [],
      rounds: 1,
      state: 'completed',
      status: 'completed',
      createdAt: '2026-08-30T20:00:00.000Z',
      updatedAt: '2026-08-30T20:00:01.000Z',
      transcriptLength: 1,
      failures: [],
      outputChars: 12,
      transcript: [{
        schema: 'rapp-group-transcript/1.0',
        id: 'turn-1',
        groupId: 'ui-group',
        messageId: 'message-1',
        sequence: 1,
        round: 1,
        participant: {
          rappid: participants[0].rappid,
          liveId: participants[0].liveId,
          liveLabel: participants[0].liveLabel,
          harness: participants[0].metadata.harness,
        },
        prompt: 'Compare options.',
        envelope: {
          schema: 'rapp-chat/1.0',
          status: 'success',
          response: 'Safe option.',
          content: 'Safe option.',
          session_id: 'ui-group',
          sessionId: 'ui-group',
          agent_logs: '',
          voice_mode: false,
          model: 'fake',
          requested_model: 'fake',
        },
        completedAt: '2026-08-30T20:00:01.000Z',
      }],
    });

    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    const groupButton = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.toolbar button') ?? [],
    ).find(button => button.textContent?.includes('Group'));
    expect(groupButton).toBeTruthy();
    expect(groupButton?.getAttribute('aria-pressed')).toBe('false');
    groupButton!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      composed: true,
    }));
    await settle(element);
    expect(
      element.shadowRoot?.querySelector<HTMLButtonElement>('[data-mode="patient"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    groupButton!.click();
    await settle(element);

    expect(element.shadowRoot?.querySelector('fieldset legend')?.textContent)
      .toContain('Participants');
    const choices = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][data-rappid]',
      ) ?? [],
    );
    expect(choices).toHaveLength(3);
    expect(choices.map(choice => choice.dataset.rappid)).toEqual(IDS);
    expect(choices.every(choice => choice.checked)).toBe(true);
    expect(element.shadowRoot?.textContent).toContain(participants[0].liveLabel);
    expect(element.shadowRoot?.textContent).not.toContain(IDS[0]);

    const composer = element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea');
    composer!.value = 'Compare options.';
    composer!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await settle(element);
    element.shadowRoot?.querySelector<HTMLButtonElement>('.send')?.click();
    await settle(element);

    expect(mocks.createGroup).toHaveBeenCalledWith([...IDS]);
    expect(mocks.sendGroupTurn).toHaveBeenCalledWith(
      'ui-group',
      'Compare options.',
      expect.any(AbortSignal),
    );
    expect(element.shadowRoot?.textContent).toContain('Safe option.');
    expect(element.shadowRoot?.textContent).toContain(participants[0].liveLabel);
  });
});
