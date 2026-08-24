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
    const input = element.shadowRoot!.querySelector('input')!;
    input.value = key;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await element.updateComplete;
    const save = [...element.shadowRoot!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Verify & save'))!;
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await element.updateComplete;

    expect(voice).toHaveBeenCalledWith({ action: 'credential.set', apiKey: key });
    expect((element.shadowRoot!.querySelector('input') as HTMLInputElement).value).toBe('');
    expect(element.shadowRoot!.textContent).not.toContain(key);
  });
});
