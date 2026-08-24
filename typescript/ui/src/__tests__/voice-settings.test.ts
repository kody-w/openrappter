// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../components/voice-settings.js';

interface VoiceSettingsElement extends HTMLElement {
  updateComplete: Promise<boolean>;
}

const status = {
  enabled: false,
  provider: 'elevenlabs',
  providers: [
    { id: 'system', name: 'System voice', available: true, configured: true },
    { id: 'local', name: 'Local voice', available: true, configured: true },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      available: false,
      configured: false,
      verified: false,
    },
  ],
  disclosure: 'Only exact final assistant text is sent. User prompts are never sent.',
};

function installBridge(voice: (request: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  Object.defineProperty(window, 'openrappterDesktop', {
    configurable: true,
    value: {
      platform: 'darwin',
      gatewayUrl: 'ws://127.0.0.1',
      gatewayToken: 'test',
      voice,
      showAndTell: vi.fn(),
      desktopControl: vi.fn(),
      narration: vi.fn(),
      onNarrationStatus: vi.fn(() => () => {}),
      onVoiceStatus: vi.fn(() => () => {}),
      getInfo: vi.fn(),
    },
  });
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'openrappterDesktop');
  vi.restoreAllMocks();
});

describe('ElevenLabs inline voice settings', () => {
  it('shows reviewed back-and-forth conversation controls with save and cancel', async () => {
    installBridge(vi.fn(async () => ({
      ...status,
      settings: {
        outputEnabled: false,
        autoSpeak: false,
        provider: 'local',
        inputEnabled: false,
        continuousConversation: false,
        pushToTalkKey: 'Space',
        transcriptPolicy: 'review',
        inputDeviceId: 'default',
        backgroundBehavior: 'pause',
        wakeLock: 'never',
      },
      inputDevices: [{ id: 'default', label: 'Default microphone' }],
    })));
    const element = document.createElement('openrappter-voice-settings') as VoiceSettingsElement;
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    const root = element.shadowRoot!;
    for (const label of [
      'Enable voice output',
      'Auto-speak responses',
      'Enable voice input',
      'Continuous conversation mode',
      'Push-to-talk key',
      'Input device',
      'Review transcript before sending',
      'Save settings',
      'Cancel',
    ]) {
      expect(root.textContent).toContain(label);
    }
    expect(root.querySelector('[aria-live="assertive"]')).not.toBeNull();
  });

  it('persists only reviewed display settings and cancel discards a draft', async () => {
    const baseSettings = {
      outputEnabled: false,
      autoSpeak: false,
      provider: 'local',
      inputEnabled: false,
      continuousConversation: false,
      pushToTalkKey: 'Space',
      inputDeviceId: 'default',
      transcriptPolicy: 'review',
      backgroundBehavior: 'pause',
      wakeLock: 'never',
      silenceMs: 800,
      noSpeechTimeoutMs: 10_000,
      maxListenMs: 30_000,
      vadThreshold: 0.025,
      operationTimeoutMs: 30_000,
      thinkingTimeoutMs: 120_000,
    };
    const voice = vi.fn(async (request: Record<string, unknown>) => {
      if (request.action === 'settings.save') {
        return {
          ...status,
          providers: status.providers,
          settings: request.settings,
        };
      }
      return { ...status, settings: baseSettings };
    });
    installBridge(voice);
    const element = document.createElement('openrappter-voice-settings') as VoiceSettingsElement;
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    const root = element.shadowRoot!;
    const output = [...root.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Enable voice output'))
      ?.querySelector('input') as HTMLInputElement;
    output.checked = true;
    output.dispatchEvent(new Event('change', { bubbles: true }));
    await element.updateComplete;
    const cancel = [...root.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await element.updateComplete;
    expect(output.checked).toBe(false);
    expect(voice).not.toHaveBeenCalledWith(expect.objectContaining({
      action: 'settings.save',
    }));

    output.checked = true;
    output.dispatchEvent(new Event('change', { bubbles: true }));
    const save = [...root.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Save settings'))!;
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(voice).toHaveBeenCalledWith(expect.objectContaining({
      action: 'settings.save',
      settings: expect.objectContaining({
        outputEnabled: true,
        pushToTalkKey: 'Space',
      }),
    }));
    const saved = voice.mock.calls.find(
      ([request]) => request.action === 'settings.save',
    )?.[0];
    expect(JSON.stringify(saved)).not.toContain('apiKey');
  });

  it('renders provider setup, disclosure, keyboard labels, and a non-ready failed key state', async () => {
    installBridge(vi.fn(async (request) => {
      if (request.action === 'status') return status;
      throw new Error('The ElevenLabs credential is invalid.');
    }));
    const element = document.createElement('openrappter-voice-settings') as VoiceSettingsElement;
    document.body.append(element);
    await element.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    const root = element.shadowRoot!;
    expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(root.textContent).toContain('Not verified');
    expect(root.textContent).toContain('User prompts are never sent');
    expect(root.querySelector('input[type="password"][autocomplete="off"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Close voice settings"]')).not.toBeNull();
  });

  it('submits the key once, clears the renderer input, and never renders the raw value', async () => {
    const key = `sk_${'g'.repeat(40)}`;
    const voice = vi.fn(async (request: Record<string, unknown>) => {
      if (request.action === 'status') return status;
      if (request.action === 'credential.set') {
        return {
          success: true,
          credential: {
            present: true,
            masked: '••••••••',
            verified: true,
            verifiedAt: '2026-08-23T12:00:00.000Z',
          },
        };
      }
      return status;
    });
    installBridge(voice);
    const element = document.createElement('openrappter-voice-settings') as VoiceSettingsElement;
    document.body.append(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;
    const input = element.shadowRoot!.querySelector(
      'input[type="password"]',
    ) as HTMLInputElement;
    input.value = key;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await element.updateComplete;
    const save = [...element.shadowRoot!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Verify & save'))!;
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(voice).toHaveBeenCalledWith({ action: 'credential.set', apiKey: key });
    expect((
      element.shadowRoot!.querySelector('input[type="password"]') as HTMLInputElement
    ).value).toBe('');
    expect(element.shadowRoot!.textContent).not.toContain(key);
  });
});
