import { describe, expect, it, vi } from 'vitest';
import {
  GrailVoiceInputCapture,
  type VoiceCaptureBackend,
  type VoiceCaptureSource,
} from '../services/voice-input.js';

class FakeSource implements VoiceCaptureSource {
  readonly sampleRate = 16_000;
  readonly deviceId = 'mic-1';
  close = vi.fn(async () => undefined);
  private frame?: (samples: Float32Array) => void;
  private ended?: () => void;
  connect(
    frame: (samples: Float32Array) => void,
    ended: () => void,
  ): void {
    this.frame = frame;
    this.ended = ended;
  }
  emit(level: number, milliseconds: number): void {
    const samples = new Float32Array(Math.round(this.sampleRate * milliseconds / 1_000));
    samples.fill(level);
    this.frame?.(samples);
  }
  disconnect(): void {
    this.ended?.();
  }
}

function fakeBackend() {
  const source = new FakeSource();
  let deviceChange: (() => void) | undefined;
  const backend: VoiceCaptureBackend = {
    listInputDevices: vi.fn(async () => [
      { id: 'default', label: 'Default microphone' },
      { id: 'mic-1', label: 'Desk microphone' },
    ]),
    open: vi.fn(async () => source),
    onDeviceChange: (callback) => {
      deviceChange = callback;
      return () => { deviceChange = undefined; };
    },
  };
  return { source, backend, deviceChanged: () => deviceChange?.() };
}

const settings = {
  inputEnabled: true,
  inputDeviceId: 'mic-1',
  silenceMs: 400,
  noSpeechTimeoutMs: 2_000,
  maxListenMs: 5_000,
  vadThreshold: 0.02,
};

describe('Grail browser voice input capture', () => {
  it('never opens the microphone while voice input is toggled off', async () => {
    const { backend } = fakeBackend();
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: vi.fn(),
      onError: vi.fn(),
      onListeningChanged: vi.fn(),
    });
    await expect(capture.start({
      ...settings,
      inputEnabled: false,
    }, 'continuous')).rejects.toThrow(/disabled/i);
    expect(backend.open).not.toHaveBeenCalled();
  });

  it('captures bounded local PCM and endpoints after speech plus silence', async () => {
    const { source, backend } = fakeBackend();
    const endpoint = vi.fn(async () => undefined);
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: endpoint,
      onError: vi.fn(),
      onListeningChanged: vi.fn(),
    });
    await capture.start(settings, 'continuous');
    source.emit(0.001, 300);
    source.emit(0.2, 300);
    source.emit(0.2, 300);
    source.emit(0.001, 500);
    await capture.settled();
    expect(endpoint).toHaveBeenCalledTimes(1);
    const pcm = endpoint.mock.calls[0][0] as Uint8Array;
    expect(pcm.byteLength).toBeGreaterThan(0);
    expect(source.close).toHaveBeenCalled();
  });

  it('push-to-talk submits only on release', async () => {
    const { source, backend } = fakeBackend();
    const endpoint = vi.fn(async () => undefined);
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: endpoint,
      onError: vi.fn(),
      onListeningChanged: vi.fn(),
    });
    await capture.start(settings, 'push-to-talk');
    source.emit(0.1, 400);
    expect(endpoint).not.toHaveBeenCalled();
    await capture.releasePushToTalk();
    expect(endpoint).toHaveBeenCalledTimes(1);
  });

  it('fails closed on microphone permission denial', async () => {
    const { backend } = fakeBackend();
    backend.open = vi.fn(async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    });
    const error = vi.fn();
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: vi.fn(),
      onError: error,
      onListeningChanged: vi.fn(),
    });
    await expect(capture.start(settings, 'continuous')).rejects.toThrow(/permission/i);
    expect(error).toHaveBeenCalledWith('mic-permission-denied');
    expect(capture.active).toBe(false);
  });

  it('stops and reports selected-device disconnect without retaining audio', async () => {
    const { source, backend, deviceChanged } = fakeBackend();
    const error = vi.fn();
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: vi.fn(),
      onError: error,
      onListeningChanged: vi.fn(),
    });
    await capture.start(settings, 'continuous');
    source.emit(0.1, 200);
    backend.listInputDevices = vi.fn(async () => [
      { id: 'default', label: 'Default microphone' },
    ]);
    deviceChanged();
    await capture.settled();
    expect(error).toHaveBeenCalledWith('device-disconnected');
    expect(source.close).toHaveBeenCalled();
    expect(capture.retainedBytes).toBe(0);
  });

  it('can reconnect only after an explicit new start', async () => {
    const { source, backend } = fakeBackend();
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: vi.fn(),
      onError: vi.fn(),
      onListeningChanged: vi.fn(),
    });
    await capture.start(settings, 'continuous');
    source.disconnect();
    await capture.settled();
    expect(capture.active).toBe(false);
    await capture.start(settings, 'continuous');
    expect(backend.open).toHaveBeenCalledTimes(2);
  });

  it('closes a late microphone grant after stop instead of resurrecting capture', async () => {
    const { source, backend } = fakeBackend();
    let grant!: (source: VoiceCaptureSource) => void;
    backend.open = vi.fn(async () => new Promise<VoiceCaptureSource>((resolve) => {
      grant = resolve;
    }));
    const endpoint = vi.fn();
    const capture = new GrailVoiceInputCapture(backend, {
      onEndpoint: endpoint,
      onError: vi.fn(),
      onListeningChanged: vi.fn(),
    });
    const starting = capture.start(settings, 'continuous');
    await Promise.resolve();
    expect(capture.active).toBe(true);
    await capture.stop();
    grant(source);
    await starting;
    expect(source.close).toHaveBeenCalled();
    expect(capture.active).toBe(false);
    expect(endpoint).not.toHaveBeenCalled();
  });
});
