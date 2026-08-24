// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../components/show-and-tell.js';

interface TestShowAndTellElement extends HTMLElement {
  session: { id: string; state: string } | null;
  narrationState: string;
  startNarration(): Promise<void>;
  stopNarration(): Promise<void>;
}

describe('Show-and-Tell narration lifecycle', () => {
  afterEach(() => {
    delete window.openrappterDesktop;
    vi.restoreAllMocks();
  });

  it('does not acquire the microphone after the recording stops during model setup', async () => {
    let finishDownload!: (value: Record<string, unknown>) => void;
    const download = new Promise<Record<string, unknown>>((resolve) => {
      finishDownload = resolve;
    });
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    window.openrappterDesktop = {
      platform: 'darwin',
      gatewayUrl: 'ws://127.0.0.1:18791',
      gatewayToken: 'test',
      showAndTell: vi.fn(),
      desktopControl: vi.fn(),
      narration: vi.fn().mockReturnValue(download),
      buddyEvidence: vi.fn(),
      onNarrationStatus: vi.fn().mockReturnValue(() => {}),
      voice: vi.fn(),
      onVoiceStatus: vi.fn().mockReturnValue(() => {}),
      getInfo: vi.fn(),
    };

    const element = document.createElement(
      'openrappter-show-and-tell',
    ) as TestShowAndTellElement;
    element.session = { id: 'session-1', state: 'recording' };
    element.narrationState = 'missing';

    const starting = element.startNarration();
    await Promise.resolve();
    element.session = { id: 'session-1', state: 'stopped' };
    await element.stopNarration();
    finishDownload({ model: 'ready', phase: 'idle' });

    await expect(starting).rejects.toThrow(/cancelled|recording/i);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
