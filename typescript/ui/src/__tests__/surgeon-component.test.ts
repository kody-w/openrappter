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
  loadCopilotAuthState: vi.fn(),
  retryCopilotAuth: vi.fn(),
  beginCopilotSignIn: vi.fn(),
  pollCopilotSignIn: vi.fn(),
  cancelCopilotSignIn: vi.fn(),
  openCopilotVerification: vi.fn(),
  retryCopilotModel: vi.fn(),
  selectCopilotModel: vi.fn(),
  copilotActionsReady: vi.fn((state) =>
    state.status === 'ready' && state.model?.status === 'ready'
  ),
  askPatient: vi.fn(),
  probePatientTransport: vi.fn(),
  getPatientTransportState: vi.fn(),
  cancelPatientRequest: vi.fn(),
}));

vi.mock('../services/surgeon.js', () => mocks);
vi.mock('../services/copilot-auth.js', () => ({
  loadCopilotAuthState: mocks.loadCopilotAuthState,
  retryCopilotAuth: mocks.retryCopilotAuth,
  beginCopilotSignIn: mocks.beginCopilotSignIn,
  pollCopilotSignIn: mocks.pollCopilotSignIn,
  cancelCopilotSignIn: mocks.cancelCopilotSignIn,
  openCopilotVerification: mocks.openCopilotVerification,
  retryCopilotModel: mocks.retryCopilotModel,
  selectCopilotModel: mocks.selectCopilotModel,
  copilotActionsReady: mocks.copilotActionsReady,
}));
vi.mock('../services/patient.js', () => ({
  askPatient: mocks.askPatient,
  probePatientTransport: mocks.probePatientTransport,
  getPatientTransportState: mocks.getPatientTransportState,
  cancelPatientRequest: mocks.cancelPatientRequest,
}));

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
    mocks.probePatientTransport.mockResolvedValue({
      status: 'ready',
      message: 'Public patient chat is ready.',
      retryable: false,
    });
    mocks.getPatientTransportState.mockReturnValue({
      status: 'ready',
      message: 'Public patient chat is ready.',
      retryable: false,
    });
    mocks.loadCopilotAuthState.mockResolvedValue({
      status: 'ready',
      code: 'COPILOT_READY',
      message: 'GitHub Copilot is ready.',
      retryable: false,
      model: {
        status: 'ready',
        code: 'COPILOT_MODEL_READY',
        message: 'Model ready.',
        availableModels: ['supported-model'],
        selectedModel: 'supported-model',
        explicitConfigured: true,
        retryable: false,
      },
    });
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

  it('uses readable radio semantics with roving keyboard mode selection', async () => {
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);
    const surgeon = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-mode="surgeon"]',
    )!;
    const patientMode = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-mode="patient"]',
    )!;
    const group = element.shadowRoot?.querySelector('.mode-switcher');

    expect(group?.getAttribute('role')).toBe('radiogroup');
    expect(surgeon.getAttribute('role')).toBe('radio');
    expect(surgeon.getAttribute('aria-checked')).toBe('true');
    expect(surgeon.dataset.state).toBe('selected');
    expect(surgeon.tabIndex).toBe(0);
    expect(patientMode.dataset.state).toBe('unselected');
    expect(patientMode.tabIndex).toBe(-1);

    surgeon.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
    }));
    await settle(element);
    expect(patientMode.getAttribute('aria-checked')).toBe('true');
    expect(patientMode.dataset.state).toBe('selected');
    expect(element.shadowRoot?.activeElement).toBe(patientMode);
    expect(element.shadowRoot?.querySelector('.mode-status')?.textContent)
      .toContain('Observing: Patient mode');

    surgeon.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }));
    await settle(element);
    expect(surgeon.getAttribute('aria-checked')).toBe('true');
    expect(element.shadowRoot?.activeElement).toBe(surgeon);
  });

  it('does not claim Patient READY when the exact public chat probe is unreachable', async () => {
    mocks.probePatientTransport
      .mockResolvedValueOnce({
        status: 'offline',
        message: 'The public patient chat endpoint is offline or unreachable.',
        retryable: true,
      })
      .mockResolvedValueOnce({
        status: 'ready',
        message: 'Public patient chat is ready.',
        retryable: false,
      });
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);
    const patientMode = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-mode="patient"]',
    )!;

    expect(patientMode.disabled).toBe(true);
    expect(patientMode.dataset.state).toBe('transport-unavailable');
    expect(patientMode.title).toContain('offline or unreachable');
    expect(element.shadowRoot?.querySelector('.mode-status')?.textContent)
      .not.toContain('Patient mode — public chat ready');
    expect(element.shadowRoot?.textContent).toContain('Patient chat unavailable');
    expect(mocks.askPatient).not.toHaveBeenCalled();

    const retry = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>(
        '.patient-transport-banner button',
      ) ?? [],
    ).find((button) => button.textContent?.includes('Retry public chat'));
    retry!.click();
    await settle(element);
    expect(patientMode.disabled).toBe(false);
  });

  it('persists no patient turn when the public chat request fails', async () => {
    mocks.askPatient.mockRejectedValueOnce(new Error(
      'The public patient chat endpoint is offline or unreachable.',
    ));
    mocks.getPatientTransportState.mockReturnValue({
      status: 'offline',
      message: 'The public patient chat endpoint is offline or unreachable.',
      retryable: true,
    });
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);
    const patientMode = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-mode="patient"]',
    )!;
    patientMode.click();
    await settle(element);
    const portal = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '.starter-portals .portal',
    )!;
    portal.click();
    await settle(element);

    expect(mocks.askPatient).toHaveBeenCalledOnce();
    expect(element.shadowRoot?.textContent).not.toContain('must not reach');
    expect(element.shadowRoot?.querySelectorAll('.turn')).toHaveLength(0);
    expect(element.shadowRoot?.textContent).toContain(
      'The public patient chat endpoint is offline or unreachable.',
    );
  });

  it('turns the production HTTP 401 into inline reauthentication without a fake answer', async () => {
    mocks.sendTurn.mockRejectedValueOnce(new Error(
      'GitHub token does not have Copilot API access (HTTP 401). Sign in with a GitHub account that has Copilot enabled.',
    ));
    mocks.loadCopilotAuthState
      .mockResolvedValueOnce({
        status: 'ready',
        code: 'COPILOT_READY',
        message: 'GitHub Copilot is ready.',
        retryable: false,
        model: {
          status: 'ready',
          code: 'COPILOT_MODEL_READY',
          message: 'Model ready.',
          availableModels: ['supported-model'],
          selectedModel: 'supported-model',
          explicitConfigured: true,
          retryable: false,
        },
      })
      .mockResolvedValue({
        status: 'needs-sign-in',
        code: 'COPILOT_HTTP_401',
        message: 'GitHub rejected this credential (HTTP 401). Sign in again to use Copilot.',
        retryable: true,
        action: 'sign-in',
      });
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    element.shadowRoot?.querySelector<HTMLButtonElement>('.portal')?.click();
    await settle(element);

    const connect = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.auth-banner button') ?? [],
    ).find(button => button.textContent?.includes('Sign in with GitHub Copilot'));
    expect(connect).toBeTruthy();
    expect(element.shadowRoot?.textContent).not.toContain(
      'The patient is stable and ready for deeper inspection.',
    );
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true);
    expect(Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tbtn') ?? [],
    ).every((button) => button.disabled)).toBe(true);
    expect(Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tbtn') ?? [],
    ).every((button) =>
      button.dataset.state === 'auth-unavailable'
      && button.getAttribute('aria-describedby') === 'copilot-mode-status'
      && Boolean(button.title)
    )).toBe(true);
    expect(element.shadowRoot?.querySelector('.mode-status')?.textContent)
      .toContain('Observing: Surgeon mode');
  });

  it('routes offline fallback only to deterministic local health without invoking a provider', async () => {
    const previous = result();
    mocks.loadCases.mockResolvedValue([previous.case]);
    mocks.loadCopilotAuthState.mockResolvedValue({
      status: 'offline',
      code: 'COPILOT_OFFLINE',
      message: 'Copilot could not be reached. Local health and estate tools remain available.',
      retryable: true,
      action: 'retry',
    });

    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    const navigate = vi.fn();
    element.addEventListener('navigate', navigate);
    document.body.append(element);
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('Cached Copilot consultation');
    const localHealth = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.auth-banner button') ?? [],
    ).find(button => button.textContent?.includes('View local health'));
    expect(localHealth).toBeTruthy();
    localHealth!.click();
    expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({
      view: 'presence',
    });

    const patientMode = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tbtn') ?? [],
    ).find(button => button.textContent?.includes('Patient'));
    expect(patientMode?.disabled).toBe(true);
    patientMode!.click();
    await settle(element);
    await (element as unknown as {
      askThePatient(value: string): Promise<void>;
    }).askThePatient('must not reach the stale provider');
    expect(element.shadowRoot?.querySelector<HTMLTextAreaElement>('textarea')?.disabled)
      .toBe(true);
    expect(mocks.askPatient).not.toHaveBeenCalled();
    expect(mocks.sendTurn).not.toHaveBeenCalled();
    expect(element.shadowRoot?.textContent).not.toContain('Use local patient tools');
  });

  it('shows only verified model choices and caches stale consultation after HTTP 400', async () => {
    const previous = result();
    mocks.loadCases.mockResolvedValue([previous.case]);
    mocks.sendTurn.mockRejectedValueOnce(new Error(
      'The configured Copilot model "unsupported-model" is not supported.',
    ));
    mocks.loadCopilotAuthState
      .mockResolvedValueOnce({
        status: 'ready',
        code: 'COPILOT_READY',
        message: 'GitHub Copilot is ready.',
        retryable: false,
        model: {
          status: 'ready',
          code: 'COPILOT_MODEL_READY',
          message: 'Model ready.',
          availableModels: ['unsupported-model'],
          selectedModel: 'unsupported-model',
          explicitConfigured: true,
          retryable: false,
        },
      })
      .mockResolvedValue({
        status: 'ready',
        code: 'COPILOT_READY',
        message: 'GitHub Copilot is ready.',
        retryable: false,
        model: {
          status: 'model-not-supported',
          code: 'COPILOT_MODEL_NOT_SUPPORTED',
          message: 'The configured Copilot model "unsupported-model" is not supported by this account.',
          availableModels: ['supported-model'],
          configuredModel: 'unsupported-model',
          recommendedModel: 'supported-model',
          explicitConfigured: true,
          retryable: true,
        },
      });
    mocks.selectCopilotModel.mockResolvedValue({
      status: 'ready',
      code: 'COPILOT_MODEL_READY',
      message: 'Model ready.',
      availableModels: ['supported-model'],
      configuredModel: 'supported-model',
      selectedModel: 'supported-model',
      explicitConfigured: true,
      retryable: false,
    });
    const element = document.createElement('openrappter-surgeon') as SurgeonElement;
    document.body.append(element);
    await settle(element);

    element.shadowRoot?.querySelector<HTMLButtonElement>('.portal')!.click();
    await settle(element);

    expect(element.shadowRoot?.textContent).toContain('Cached Copilot consultation');
    expect(element.shadowRoot?.textContent).toContain('unsupported-model');
    expect(element.shadowRoot?.textContent).toContain('Use recommended model');
    expect(Array.from(
      element.shadowRoot?.querySelectorAll<HTMLOptionElement>('option') ?? [],
    ).map((option) => option.value)).toEqual(['supported-model']);
    expect(element.shadowRoot?.textContent).not.toContain('model_not_supported');
    expect(element.shadowRoot?.querySelector<HTMLButtonElement>('.send')?.disabled)
      .toBe(true);
    expect(Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tbtn') ?? [],
    ).every((button) => button.dataset.state === 'model-unavailable'))
      .toBe(true);
    const recommended = Array.from(
      element.shadowRoot?.querySelectorAll<HTMLButtonElement>('.model-resolution button') ?? [],
    ).find((button) => button.textContent?.includes('Use recommended model'));
    recommended!.click();
    await settle(element);
    expect(mocks.selectCopilotModel).toHaveBeenCalledWith('supported-model');
  });
});

describe('openrappter-surgeon superseded proposals', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('never offers approval for a proposal the case has moved past', async () => {
    mocks.loadCopilotAuthState.mockResolvedValue({
      status: 'ready',
      code: 'COPILOT_READY',
      message: 'GitHub Copilot is ready.',
      retryable: false,
    });
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
