import { afterEach, describe, expect, it, vi } from 'vitest';

import '../components/xpedition-onboarding.js';
import '../components/xpedition-shell.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  ONBOARDING_STEPS,
  loadXpeditionPreferences,
  saveXpeditionPreferences,
  type StorageLike,
} from '../services/xpedition.js';
import type { OpenRappterXpeditionOnboarding } from '../components/xpedition-onboarding.js';
import type { OpenRappterXpeditionShell } from '../components/xpedition-shell.js';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function onboarding(connected = false) {
  const element = document.createElement(
    'openrappter-xpedition-onboarding',
  ) as OpenRappterXpeditionOnboarding;
  element.connected = connected;
  element.connectionError = connected ? '' : 'fixture gateway offline';
  document.body.append(element);
  await element.updateComplete;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return element;
}

describe('XPedition onboarding migration and modal accessibility', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('keeps Use Legacy OpenRappter visible on every step and offline error', async () => {
    const element = await onboarding(false);
    for (const step of ONBOARDING_STEPS) {
      element.selectStep(step);
      await element.updateComplete;
      const legacy = element.shadowRoot!.querySelector<HTMLButtonElement>(
        'button.legacy',
      );
      expect(legacy, step).not.toBeNull();
      expect(legacy!.textContent).toContain('Use Legacy OpenRappter');
    }
    element.selectStep('gateway');
    await element.updateComplete;
    expect(element.shadowRoot!.textContent).toContain('fixture gateway offline');
    expect(element.shadowRoot!.querySelector('button.legacy')).not.toBeNull();
  });

  it('switches offline to legacy and preserves unrelated saved state', async () => {
    const storage = new MemoryStorage();
    storage.setItem('openrappter.existing.sessions', 'preserve-me');
    saveXpeditionPreferences(storage, {
      ...DEFAULT_XPEDITION_PREFERENCES,
      onboardingCompleted: false,
    });
    const shell = document.createElement(
      'openrappter-xpedition-shell',
    ) as OpenRappterXpeditionShell;
    shell.storage = storage;
    shell.connected = false;
    shell.connectionError = 'offline';
    document.body.append(shell);
    await shell.updateComplete;
    const switched = vi.fn();
    shell.addEventListener('switch-shell', switched);
    const wizard = shell.shadowRoot!.querySelector(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding;
    await wizard.updateComplete;
    wizard.shadowRoot!.querySelector<HTMLButtonElement>('button.legacy')!.click();
    expect(loadXpeditionPreferences(storage).shell).toBe('legacy');
    expect(storage.getItem('openrappter.existing.sessions')).toBe('preserve-me');
    expect(switched).toHaveBeenCalledOnce();
  });

  it('uses modal semantics, initial focus, and an inert background', async () => {
    const storage = new MemoryStorage();
    saveXpeditionPreferences(storage, {
      ...DEFAULT_XPEDITION_PREFERENCES,
      onboardingCompleted: false,
    });
    const shell = document.createElement(
      'openrappter-xpedition-shell',
    ) as OpenRappterXpeditionShell;
    shell.storage = storage;
    document.body.append(shell);
    await shell.updateComplete;
    const wizard = shell.shadowRoot!.querySelector(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding;
    await wizard.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dialog = wizard.shadowRoot!.querySelector<HTMLElement>(
      '[role="dialog"]',
    )!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('wizard-title');
    expect(dialog.getAttribute('aria-describedby')).toContain('wizard-status');
    expect(wizard.shadowRoot!.activeElement).toBe(dialog);
    for (const selector of ['.shortcuts', '.taskbar']) {
      const background = shell.shadowRoot!.querySelector<HTMLElement>(selector)!;
      expect(background.hasAttribute('inert')).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('contains Tab and Shift-Tab inside the modal', async () => {
    const element = await onboarding(false);
    const buttons = Array.from(
      element.shadowRoot!.querySelectorAll<HTMLButtonElement>(
        'button:not([disabled])',
      ),
    );
    const legacy = element.shadowRoot!.querySelector<HTMLButtonElement>(
      'button.legacy',
    )!;
    const last = buttons[buttons.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      composed: true,
    }));
    expect(element.shadowRoot!.activeElement).toBe(legacy);
    legacy.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      composed: true,
    }));
    expect(element.shadowRoot!.activeElement).toBe(last);
  });

  it('keeps setup open on Escape and focuses the safe legacy path', async () => {
    const element = await onboarding(false);
    const dialog = element.shadowRoot!.querySelector<HTMLElement>(
      '[role="dialog"]',
    )!;
    dialog.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      composed: true,
    }));
    await element.updateComplete;
    expect(element.isConnected).toBe(true);
    expect(element.shadowRoot!.activeElement).toBe(
      element.shadowRoot!.querySelector('button.legacy'),
    );
    expect(element.shadowRoot!.querySelector('#wizard-status')?.textContent)
      .toContain('Setup remains open');
  });

  it('restores focus when onboarding is removed', async () => {
    const prior = document.createElement('button');
    prior.textContent = 'Prior control';
    document.body.append(prior);
    prior.focus();
    const element = await onboarding(false);
    expect(element.shadowRoot!.activeElement?.getAttribute('role')).toBe('dialog');
    element.remove();
    expect(document.activeElement).toBe(prior);
  });
});
