// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SurgeonCase,
  SurgeonConsultResult,
  SurgeonPatientSnapshot,
} from '../types.js';

const mocks = vi.hoisted(() => ({
  loadPatient: vi.fn(),
  loadCases: vi.fn(),
  sendTurn: vi.fn(),
  approveProcedure: vi.fn(),
  rejectProcedure: vi.fn(),
  operate: vi.fn(),
}));

vi.mock('../services/surgeon.js', () => mocks);

import '../components/surgeon.js';

interface SurgeonElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const patient: SurgeonPatientSnapshot = {
  capturedAt: '2026-08-02T01:00:00.000Z',
  patient: 'OpenRappter',
  version: '1.10.0',
  state: 'stable',
  uptimeSeconds: 120,
  tissues: [{
    id: 'gateway',
    label: 'Brainstem',
    status: 'stable',
    summary: 'Gateway responsive.',
  }],
  inventory: {
    agents: ['Shell', 'Memory'],
    channels: [],
    scheduledJobs: ['DailyTip'],
  },
  metrics: {
    connections: 1,
    agents: 32,
    configuredChannels: 0,
    connectedChannels: 0,
    scheduledJobs: 1,
    activeCases: 0,
  },
};

function result(): SurgeonConsultResult {
  const turn = {
    id: 'turn-1',
    kind: 'consultation' as const,
    response: 'The patient is stable and ready for deeper inspection.',
    voiceLine: 'The patient is stable.',
    prompt: 'Where next?',
    options: [{
      label: 'Inspect memory',
      value: 'Inspect OpenRappter memory for unhealthy patterns.',
    }, {
      label: 'Inspect channels',
      value: 'Inspect OpenRappter channels for broken signals.',
    }],
    diagnosis: {
      summary: 'No acute fault detected.',
      severity: 'stable' as const,
      findings: ['Gateway responsive'],
    },
    createdAt: '2026-08-02T01:00:00.000Z',
  };
  const patientCase: SurgeonCase = {
    id: 'case-1',
    status: 'observing',
    createdAt: '2026-08-02T01:00:00.000Z',
    updatedAt: '2026-08-02T01:00:00.000Z',
    patientAtDiagnosis: patient,
    turns: [{
      userInput: 'Run a full examination.',
      turn,
      createdAt: turn.createdAt,
    }],
  };
  return { case: patientCase, turn, patient };
}

async function settle(element: SurgeonElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
}

describe('openrappter-surgeon', () => {
  beforeEach(() => {
    mocks.loadPatient.mockResolvedValue(patient);
    mocks.loadCases.mockResolvedValue([]);
    mocks.sendTurn.mockResolvedValue(result());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('uses an AI-generated portal to reshape the next interaction', async () => {
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('It’s above that.');
    expect(element.shadowRoot?.textContent).toContain('Run a full examination');

    const portal = element.shadowRoot?.querySelector<HTMLButtonElement>('.portal');
    expect(portal).toBeTruthy();
    portal!.click();
    await settle(element);

    expect(mocks.sendTurn).toHaveBeenCalledWith(
      'Run a full examination of OpenRappter and tell me what deserves attention.',
      undefined,
    );
    expect(element.shadowRoot?.textContent).toContain(
      'The patient is stable and ready for deeper inspection.',
    );
    expect(element.shadowRoot?.textContent).toContain('Inspect memory');
  });

  it('turns missing Copilot auth into an inline account action', async () => {
    mocks.sendTurn.mockRejectedValueOnce(new Error('Copilot CLI is not authenticated'));
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    const navigate = vi.fn();
    element.addEventListener('navigate', navigate);
    document.body.append(element);
    await settle(element);

    element.shadowRoot?.querySelector<HTMLButtonElement>('.portal')?.click();
    await settle(element);

    const connect = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.error-banner button') ?? [],
    ).find(button => button.textContent?.includes('Connect GitHub'));
    expect(connect).toBeTruthy();
    connect!.click();
    expect(navigate).toHaveBeenCalledOnce();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      view: 'accounts',
    });
  });
});

describe('openrappter-surgeon superseded proposals', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('never offers approval for a proposal the case has moved past', async () => {
    const first = result();
    const supersededProcedure = {
      id: 'procedure-old',
      digest: 'a'.repeat(64),
      patientDigest: 'b'.repeat(64),
      title: 'Old repair',
      summary: 'A proposal that a later turn replaced.',
      risk: 'low' as const,
      steps: ['Do the old thing.'],
      expectedOutcome: 'Old outcome.',
      verification: ['Old check.'],
      status: 'proposed' as const,
      proposedAt: '2026-08-02T01:00:00.000Z',
    };
    const currentProcedure = { ...supersededProcedure, id: 'procedure-new', digest: 'c'.repeat(64) };

    first.case.turns = [
      {
        userInput: 'Fix it.',
        turn: { ...first.turn, id: 'turn-old', procedure: supersededProcedure },
        createdAt: '2026-08-02T01:00:00.000Z',
      },
      {
        userInput: 'Actually fix this instead.',
        turn: { ...first.turn, id: 'turn-new', procedure: currentProcedure },
        createdAt: '2026-08-02T01:01:00.000Z',
      },
    ];
    first.case.procedure = currentProcedure;
    first.case.status = 'proposed';

    mocks.loadPatient.mockResolvedValue(patient);
    mocks.loadCases.mockResolvedValue([first.case]);

    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    const procedures = element.shadowRoot?.querySelectorAll('.procedure') ?? [];
    expect(procedures).toHaveLength(2);
    expect(procedures[0].classList.contains('superseded')).toBe(true);
    expect(procedures[0].textContent).toContain('superseded');
    expect(procedures[0].querySelector('.primary')).toBeNull();
    expect(procedures[1].classList.contains('superseded')).toBe(false);
    expect(procedures[1].querySelector('.primary')?.textContent)
      .toContain('Approve exact procedure');
  });
});
