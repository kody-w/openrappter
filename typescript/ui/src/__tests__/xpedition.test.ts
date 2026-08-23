import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../components/xpedition-onboarding.js';
import '../components/xpedition-shell.js';
import {
  handleDesktopUiCommand,
} from '../services/desktop-control.js';
import {
  DEFAULT_XPEDITION_PREFERENCES,
  FixtureReleaseRingAdapter,
  RELEASE_RINGS,
  XPEDITION_APPS,
  XPEDITION_PREFERENCES_KEY,
  XpeditionWindowManager,
  loadXpeditionPreferences,
  saveXpeditionPreferences,
  type StorageLike,
} from '../services/xpedition.js';
import {
  runFirstHealthCheck,
  type OpenRappterXpeditionOnboarding,
} from '../components/xpedition-onboarding.js';
import type { OpenRappterXpeditionShell } from '../components/xpedition-shell.js';

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function renderShell(completed = true) {
  const storage = new MemoryStorage();
  saveXpeditionPreferences(storage, {
    ...DEFAULT_XPEDITION_PREFERENCES,
    onboardingCompleted: completed,
  });
  const shell = document.createElement(
    'openrappter-xpedition-shell',
  ) as OpenRappterXpeditionShell;
  shell.storage = storage;
  shell.connected = true;
  document.body.append(shell);
  await shell.updateComplete;
  return { shell, storage };
}

describe('XPedition window manager', () => {
  it('opens one window per app and maintains focus, z-order, minimize, maximize, and close', () => {
    const changes: unknown[] = [];
    const manager = new XpeditionWindowManager((state) => changes.push(state));
    const chat = manager.open('chat');
    const skills = manager.open('skills');
    expect(manager.state.windows).toHaveLength(2);
    expect(manager.open('chat').id).toBe(chat.id);
    expect(manager.state.windows).toHaveLength(2);
    expect(manager.state.activeWindowId).toBe(chat.id);

    expect(manager.minimize(chat.id)).toBe(true);
    expect(manager.state.activeWindowId).toBe(skills.id);
    expect(manager.focus(chat.id)).toBe(true);
    expect(manager.state.windows.find((window) => window.id === chat.id)?.minimized).toBe(false);
    expect(manager.toggleMaximize(chat.id)).toBe(true);
    expect(manager.state.windows.find((window) => window.id === chat.id)?.maximized).toBe(true);
    expect(manager.move(chat.id, 999, 999)).toBe(false);
    expect(manager.close(chat.id)).toBe(true);
    expect(manager.state.activeWindowId).toBe(skills.id);
    expect(manager.close('missing')).toBe(false);
    expect(changes.length).toBeGreaterThan(5);
  });

  it('cycles only visible windows in both directions', () => {
    const manager = new XpeditionWindowManager();
    const observe = manager.open('observe');
    const chat = manager.open('chat');
    manager.open('skills');
    manager.minimize(chat.id);
    expect(manager.cycleFocus()).toBe(observe.id);
    expect(manager.cycleFocus(true)).toBe('xpedition-skills');
  });
});

describe('XPedition preference migration', () => {
  it('defaults all users to XPedition stable without deleting unrelated state', () => {
    const storage = new MemoryStorage();
    storage.setItem('openrappter.existing.sessions', 'keep-me');
    expect(loadXpeditionPreferences(storage)).toEqual(DEFAULT_XPEDITION_PREFERENCES);
    expect(storage.getItem('openrappter.existing.sessions')).toBe('keep-me');
  });

  it('honours the legacy escape hatch and rejects arbitrary rings', () => {
    const storage = new MemoryStorage();
    storage.setItem('openrappter.shell', 'legacy');
    storage.setItem(XPEDITION_PREFERENCES_KEY, JSON.stringify({
      shell: 'invalid',
      onboardingCompleted: true,
      releaseRing: 'production',
      contrast: 'ultraviolet',
    }));
    expect(loadXpeditionPreferences(storage)).toMatchObject({
      shell: 'legacy',
      onboardingCompleted: true,
      releaseRing: 'stable',
      contrast: 'light',
    });
  });

  it('persists only the bounded non-secret preference schema', () => {
    const storage = new MemoryStorage();
    saveXpeditionPreferences(storage, {
      version: 1,
      shell: 'xpedition',
      onboardingCompleted: true,
      releaseRing: 'nightly',
      contrast: 'high-contrast',
    });
    expect(JSON.parse(storage.getItem(XPEDITION_PREFERENCES_KEY)!)).toEqual({
      version: 1,
      shell: 'xpedition',
      onboardingCompleted: true,
      releaseRing: 'nightly',
      contrast: 'high-contrast',
    });
  });
});

describe('release ring adapter seam', () => {
  it('exposes exactly the typed rings and never invents manifest resolution', async () => {
    const adapter = new FixtureReleaseRingAdapter();
    expect(await adapter.available()).toEqual(RELEASE_RINGS);
    expect(await adapter.current()).toBe('stable');
    await expect(adapter.apply('stable')).resolves.toMatchObject({
      status: 'applied',
      ring: 'stable',
    });
    await expect(adapter.apply('beta')).resolves.toMatchObject({
      status: 'unavailable',
      ring: 'beta',
    });
    expect((await adapter.apply('beta')).message).toContain('No manifest was resolved');
  });
});

describe('truthful first health check', () => {
  it('returns the real gateway health response', async () => {
    const call = vi.fn().mockResolvedValue({
      status: 'ok',
      version: '1.13.0',
      checks: { gateway: true, storage: true },
    });
    await expect(runFirstHealthCheck({
      isConnected: true,
      call,
    } as never)).resolves.toMatchObject({ status: 'ok' });
    expect(call).toHaveBeenCalledWith('health');
  });

  it('keeps disconnected, invalid, and RPC errors visible as errors', async () => {
    await expect(runFirstHealthCheck({
      isConnected: false,
      call: vi.fn(),
    } as never)).rejects.toThrow(/disconnected/);
    await expect(runFirstHealthCheck({
      isConnected: true,
      call: vi.fn().mockResolvedValue({ status: 'pretend-success' }),
    } as never)).rejects.toThrow(/invalid health/);
    await expect(runFirstHealthCheck({
      isConnected: true,
      call: vi.fn().mockRejectedValue(new Error('gateway refused health')),
    } as never)).rejects.toThrow('gateway refused health');
  });
});

describe('XPedition shell product contract', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the brand, original desktop shortcuts, taskbar, tray, and real app windows', async () => {
    const { shell } = await renderShell();
    const text = shell.shadowRoot!.textContent ?? '';
    expect(text).toContain("Rapter's Clever Girl Edition");
    expect(text).toContain('Windows XPedition');
    expect(shell.shadowRoot!.querySelector('[role="application"]')).not.toBeNull();
    expect(shell.shadowRoot!.querySelector('.taskbar')).not.toBeNull();
    expect(shell.shadowRoot!.querySelector('.tray')?.textContent).toContain('Gateway connected');

    const shortcuts = shell.shadowRoot!.querySelectorAll('.shortcut');
    expect(shortcuts).toHaveLength(XPEDITION_APPS.filter((app) => app.desktop).length);
    for (const app of XPEDITION_APPS.filter((candidate) => candidate.desktop)) {
      shell.openApp(app.id);
    }
    await shell.updateComplete;
    const state = shell.getDesktopState() as { windows: Array<{ appId: string }> };
    expect(state.windows.map((window) => window.appId)).toEqual(
      XPEDITION_APPS.filter((app) => app.desktop).map((app) => app.id),
    );
    expect(shell.shadowRoot!.querySelectorAll('[role="dialog"]')).toHaveLength(state.windows.length);
    expect(shell.shadowRoot!.querySelector('openrappter-chat')).not.toBeNull();
    expect(shell.shadowRoot!.querySelector('openrappter-skills')).not.toBeNull();
  });

  it('opens Start with keyboard, exposes every app, and preserves the legacy escape hatch', async () => {
    const { shell, storage } = await renderShell();
    const desktop = shell.shadowRoot!.querySelector('.desktop')!;
    desktop.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      ctrlKey: true,
      code: 'Space',
    }));
    await shell.updateComplete;
    const start = shell.shadowRoot!.querySelector('.start-menu');
    expect(start).not.toBeNull();
    expect(start!.querySelectorAll('.start-item')).toHaveLength(XPEDITION_APPS.length);
    const legacy = Array.from(start!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Legacy OpenRappter'),
    ) as HTMLButtonElement;
    const switched = vi.fn();
    shell.addEventListener('switch-shell', switched);
    legacy.click();
    expect(switched).toHaveBeenCalled();
    expect(loadXpeditionPreferences(storage).shell).toBe('legacy');
  });

  it('keeps unavailable capabilities honest and offline errors explicit', async () => {
    const { shell } = await renderShell();
    shell.connected = false;
    shell.connectionError = 'connection refused';
    shell.openApp('memory');
    shell.openApp('terminal');
    await shell.updateComplete;
    const text = shell.shadowRoot!.textContent ?? '';
    expect(text).toContain('Gateway offline');
    expect(text).toContain('does not yet expose a bounded Memory UI RPC');
    expect(text).toContain('No standalone terminal is exposed');
    expect(text).not.toContain('operation succeeded');
  });

  it('provides labelled window controls and keyboard focus cycling', async () => {
    const { shell } = await renderShell();
    shell.openApp('chat');
    shell.openApp('skills');
    await shell.updateComplete;
    const desktop = shell.shadowRoot!.querySelector('.desktop')!;
    desktop.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      altKey: true,
      key: 'Tab',
    }));
    const state = shell.getDesktopState() as {
      activeWindowId: string;
      windows: Array<{ title: string }>;
    };
    expect(state.activeWindowId).toBe('xpedition-chat');
    const labels = Array.from(
      shell.shadowRoot!.querySelectorAll<HTMLButtonElement>('.window-control'),
    ).map((button) => button.getAttribute('aria-label'));
    expect(labels.filter((label) => label?.startsWith('Close '))).toHaveLength(state.windows.length);
    expect(labels.filter((label) => label?.startsWith('Minimize '))).toHaveLength(state.windows.length);
  });

  it('renders the first-run wizard and supports deterministic step selection and retry', async () => {
    const { shell } = await renderShell(false);
    shell.connected = false;
    await shell.updateComplete;
    const wizard = shell.shadowRoot!.querySelector(
      'openrappter-xpedition-onboarding',
    ) as OpenRappterXpeditionOnboarding;
    expect(wizard).not.toBeNull();
    shell.selectOnboardingStep('gateway');
    await wizard.updateComplete;
    expect(wizard.currentStep).toBe('gateway');
    const retry = vi.fn();
    shell.addEventListener('retry-gateway', retry);
    const retryButton = Array.from(wizard.shadowRoot!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Retry connection'),
    )!;
    retryButton.click();
    expect(retry).toHaveBeenCalled();
    expect(() => shell.selectOnboardingStep('invented' as never)).toThrow(/Unknown onboarding/);
  });
});

describe('agent-operable semantic XPedition controls', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    const app = document.createElement('openrappter-app') as HTMLElement & Record<string, unknown>;
    Object.assign(app, {
      getDesktopState: vi.fn(() => ({ shell: 'xpedition', windows: [] })),
      openDesktopApp: vi.fn((appId: string) => ({ appId })),
      focusDesktopWindow: vi.fn((windowId: string) => ({ windowId, active: true })),
      closeDesktopWindow: vi.fn((windowId: string) => ({ windowId, closed: true })),
      selectOnboardingStep: vi.fn((step: string) => ({ step })),
      switchShell: vi.fn(),
      updateComplete: Promise.resolve(),
    });
    document.body.append(app);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('inspects state and opens, focuses, closes, and selects only bounded targets', async () => {
    await expect(handleDesktopUiCommand({ action: 'desktop_state' }))
      .resolves.toMatchObject({ shell: 'xpedition' });
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: 'chat' },
    })).resolves.toEqual({ appId: 'chat' });
    await expect(handleDesktopUiCommand({
      action: 'focus_window',
      args: { windowId: 'xpedition-chat' },
    })).resolves.toMatchObject({ active: true });
    await expect(handleDesktopUiCommand({
      action: 'close_window',
      args: { windowId: 'xpedition-chat' },
    })).resolves.toMatchObject({ closed: true });
    await expect(handleDesktopUiCommand({
      action: 'onboarding_step',
      args: { step: 'health' },
    })).resolves.toEqual({ step: 'health' });
    await expect(handleDesktopUiCommand({
      action: 'switch_shell',
      args: { shell: 'legacy' },
    })).resolves.toMatchObject({ shell: 'xpedition' });
    await expect(handleDesktopUiCommand({
      action: 'open_app',
      args: { appId: 'arbitrary-code' },
    })).rejects.toThrow(/Unknown XPedition app/);
    await expect(handleDesktopUiCommand({
      action: 'onboarding_step',
      args: { step: 'secrets' },
    })).rejects.toThrow(/Unknown onboarding step/);
  });
});
