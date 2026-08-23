import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/chat.js';
import '../components/surgeon.js';
import '../components/xpedition-onboarding.js';
import '../components/app.js';
import {
  COPILOT_READINESS_STATES,
  PendingCopilotAuthAdapter,
  copilotReadiness,
} from '../services/copilot-readiness.js';
import type { OpenRappterXpeditionOnboarding } from '../components/xpedition-onboarding.js';
import {
  handleDesktopUiCommand,
  snapshotDesktopUi,
} from '../services/desktop-control.js';

describe('typed fail-closed Copilot readiness seam', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    copilotReadiness.set({
      state: 'unknown',
      message: 'Copilot readiness has not been checked.',
    });
    vi.restoreAllMocks();
  });

  it('exports exactly the independent auth states', () => {
    expect(COPILOT_READINESS_STATES).toEqual([
      'unknown',
      'checking',
      'ready',
      'needs-sign-in',
      'no-entitlement',
      'offline',
      'error',
    ]);
  });

  it('keeps the pending adapter unknown and sign-in fail-closed', async () => {
    const adapter = new PendingCopilotAuthAdapter();
    await expect(adapter.check()).resolves.toMatchObject({
      state: 'unknown',
    });

    await expect(adapter.beginSignIn()).resolves.toMatchObject({
      state: 'needs-sign-in',
    });
  });

  it('lets the independent service install only the typed adapter seam', async () => {
    const element = document.createElement('openrappter-app') as HTMLElement & {
      setCopilotAuthAdapter(adapter: {
        check(): Promise<{ state: 'ready'; message: string }>;
        beginSignIn(): Promise<{ state: 'ready'; message: string }>;
        reportFailure(): Promise<{ state: 'error'; message: string }>;
      }): void;
    };
    element.setCopilotAuthAdapter({
      check: vi.fn().mockResolvedValue({
        state: 'ready',
        message: 'Independent auth service reports ready.',
      }),
      beginSignIn: vi.fn().mockResolvedValue({
        state: 'ready',
        message: 'Independent auth service completed sign-in.',
      }),
      reportFailure: vi.fn().mockResolvedValue({
        state: 'error',
        message: 'Independent auth service classified a failure.',
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copilotReadiness.snapshot()).toMatchObject({
      state: 'ready',
      message: 'Independent auth service reports ready.',
    });
  });

  it('maps 401, entitlement, offline, and unknown failures without success fallback', async () => {
    const adapter = new PendingCopilotAuthAdapter();
    expect((await adapter.reportFailure(Object.assign(new Error('HTTP 401'), {
      status: 401,
    }))).state).toBe('needs-sign-in');
    expect((await adapter.reportFailure(Object.assign(new Error('forbidden'), {
      status: 403,
    }))).state).toBe('no-entitlement');
    expect((await adapter.reportFailure(new Error('network offline'))).state)
      .toBe('offline');
    expect((await adapter.reportFailure(new Error('unexpected'))).state)
      .toBe('error');
  });

  it('blocks onboarding completion until Copilot is ready and offers inline sign-in', async () => {
    const element = document.createElement(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding & {
      healthState: 'success';
      finish(): void;
    };
    element.connected = true;
    element.copilotReadiness = {
      state: 'needs-sign-in',
      message: 'Copilot sign-in is required.',
    };
    document.body.append(element);
    element.selectStep('health');
    element.healthState = 'success';
    await element.updateComplete;
    const completed = vi.fn();
    const signIn = vi.fn();
    element.addEventListener('onboarding-complete', completed);
    element.addEventListener('copilot-sign-in', signIn);
    element.finish();
    expect(completed).not.toHaveBeenCalled();
    const land = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Land on desktop'))!;
    expect(land.disabled).toBe(true);
    const signInButton = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Sign in to Copilot'))!;
    const snapshot = snapshotDesktopUi();
    const signInControl = snapshot.elements.find((control) =>
      control.text.includes('Sign in to Copilot'));
    await expect(handleDesktopUiCommand({
      action: 'click',
      args: { ref: signInControl!.ref },
    })).rejects.toThrow(/sensitive/);
    expect(signIn).not.toHaveBeenCalled();
    signInButton.click();
    expect(signIn).toHaveBeenCalledOnce();
    expect(element.shadowRoot!.querySelector('button.legacy')).not.toBeNull();
  });

  it('clears stale assistant/tool content and disables OpenRappter chat on 401', async () => {
    copilotReadiness.set({
      state: 'ready',
      message: 'Copilot is ready.',
    });
    const element = document.createElement('openrappter-chat') as HTMLElement & {
      messages: Array<{ id: string; role: string; content: string; timestamp: number }>;
      toolCalls: unknown[];
      updateComplete: Promise<unknown>;
    };
    element.messages = [
      { id: 'u1', role: 'user', content: 'question', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'stale answer', timestamp: 2 },
    ];
    element.toolCalls = [{ id: 'tool-stale' }];
    document.body.append(element);
    await element.updateComplete;
    copilotReadiness.set(await new PendingCopilotAuthAdapter().reportFailure(
      Object.assign(new Error('Copilot HTTP 401'), { status: 401 }),
    ));
    await element.updateComplete;
    expect(element.messages.some((message) => message.content === 'stale answer'))
      .toBe(false);
    expect(element.messages.some((message) =>
      message.content.includes('Copilot content cleared'))).toBe(true);
    expect(element.toolCalls).toEqual([]);
    expect(element.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!.disabled)
      .toBe(true);
    expect(element.shadowRoot!.textContent).toContain('Copilot needs-sign-in');

    const target = element.shadowRoot!.querySelector<HTMLSelectElement>(
      '.brain-select',
    )!;
    target.value = 'brainstem';
    target.dispatchEvent(new Event('change'));
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!.disabled)
      .toBe(false);
  });

  it('clears stale surgeon consultation and preserves direct patient mode', async () => {
    copilotReadiness.set({
      state: 'ready',
      message: 'Copilot is ready.',
    });
    const element = document.createElement('openrappter-surgeon') as HTMLElement & {
      patientCase: unknown;
      mode: 'surgeon' | 'patient';
      staleCopilotCleared: boolean;
      updateComplete: Promise<unknown>;
    };
    document.body.append(element);
    element.patientCase = {
      id: 'case-stale',
      status: 'consulting',
      turns: [],
    };
    copilotReadiness.set(await new PendingCopilotAuthAdapter().reportFailure(
      Object.assign(new Error('HTTP 401'), { status: 401 }),
    ));
    await element.updateComplete;
    expect(element.patientCase).toBeNull();
    expect(element.staleCopilotCleared).toBe(true);
    expect(element.shadowRoot!.textContent).toContain(
      'Previous Copilot consultation content was cleared as stale.',
    );
    const surgeon = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tbtn'),
    ).find((button) => button.textContent?.includes('Surgeon'))!;
    expect(surgeon.disabled).toBe(true);
    const patient = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLButtonElement>('.tbtn'),
    ).find((button) => button.textContent?.includes('Patient'))!;
    patient.click();
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector<HTMLTextAreaElement>('textarea')!.disabled)
      .toBe(false);
  });
});
