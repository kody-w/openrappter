import { VadEndpointDetector } from '../../../src/voice/vad.js';

export interface VoiceInputDevice {
  id: string;
  label: string;
}

export interface VoiceCaptureSource {
  readonly sampleRate: number;
  readonly deviceId: string;
  connect(
    onFrame: (samples: Float32Array) => void,
    onEnded: () => void,
  ): void;
  close(): Promise<void>;
}

export interface VoiceCaptureBackend {
  listInputDevices(): Promise<VoiceInputDevice[]>;
  open(deviceId: string): Promise<VoiceCaptureSource>;
  onDeviceChange(callback: () => void): () => void;
}

export interface VoiceInputCaptureSettings {
  inputEnabled: boolean;
  inputDeviceId: string;
  silenceMs: number;
  noSpeechTimeoutMs: number;
  maxListenMs: number;
  vadThreshold: number;
}

export interface VoiceInputCaptureCallbacks {
  onEndpoint(pcm16k: Uint8Array): Promise<void>;
  onError(code: string): void;
  onListeningChanged(listening: boolean): void;
}

export type VoiceCaptureMode = 'continuous' | 'push-to-talk' | 'manual';

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample * sample;
  return Math.sqrt(total / samples.length);
}

function concatenate(chunks: readonly Float32Array[], length: number): Float32Array {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function resample(samples: Float32Array, fromRate: number, toRate = 16_000): Float32Array {
  if (fromRate === toRate) return samples;
  const outputLength = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;
  for (let index = 0; index < outputLength; index += 1) {
    const source = index * ratio;
    const left = Math.floor(source);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = source - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function permissionError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

export class GrailVoiceInputCapture {
  private source: VoiceCaptureSource | null = null;
  private detector: VadEndpointDetector | null = null;
  private chunks: Float32Array[] = [];
  private sampleCount = 0;
  private mode: VoiceCaptureMode = 'manual';
  private settings?: VoiceInputCaptureSettings;
  private finishing: Promise<void> = Promise.resolve();
  private removeDeviceListener: () => void;
  private selectedDevice = '';
  private opening = false;
  private generation = 0;

  constructor(
    private readonly backend: VoiceCaptureBackend,
    private readonly callbacks: VoiceInputCaptureCallbacks,
  ) {
    this.removeDeviceListener = backend.onDeviceChange(() => {
      this.finishing = this.checkSelectedDevice();
    });
  }

  get active(): boolean {
    return this.source !== null || this.opening;
  }

  get retainedBytes(): number {
    return this.sampleCount * Float32Array.BYTES_PER_ELEMENT;
  }

  async listInputDevices(): Promise<VoiceInputDevice[]> {
    return this.backend.listInputDevices();
  }

  async start(
    settings: VoiceInputCaptureSettings,
    mode: VoiceCaptureMode,
  ): Promise<void> {
    if (!settings.inputEnabled) throw new Error('Voice input is disabled.');
    if (this.active) throw new Error('Microphone capture is already active.');
    const generation = ++this.generation;
    this.opening = true;
    this.settings = settings;
    this.mode = mode;
    this.chunks = [];
    this.sampleCount = 0;
    this.detector = mode === 'push-to-talk'
      ? null
      : new VadEndpointDetector({
          calibrationMs: 300,
          minSpeechMs: 250,
          silenceMs: settings.silenceMs,
          noSpeechTimeoutMs: settings.noSpeechTimeoutMs,
          maxListenMs: settings.maxListenMs,
          absoluteThreshold: settings.vadThreshold,
        });
    try {
      const source = await this.backend.open(settings.inputDeviceId);
      if (generation !== this.generation) {
        await source.close();
        return;
      }
      this.source = source;
      this.selectedDevice = source.deviceId || settings.inputDeviceId;
      source.connect(
        (samples) => this.acceptFrame(samples),
        () => {
          if (!this.active) return;
          this.callbacks.onError('device-disconnected');
          this.finishing = this.finish(false);
        },
      );
      this.callbacks.onListeningChanged(true);
    } catch (error) {
      this.clearAudio();
      const code = permissionError(error)
        ? 'mic-permission-denied'
        : 'microphone-unavailable';
      this.callbacks.onError(code);
      throw new Error(
        code === 'mic-permission-denied'
          ? 'Microphone permission was denied.'
          : 'Microphone is unavailable.',
      );
    } finally {
      if (generation === this.generation) this.opening = false;
    }
  }

  async releasePushToTalk(): Promise<void> {
    if (this.mode !== 'push-to-talk' || !this.active) return;
    this.finishing = this.finish(true);
    await this.finishing;
  }

  async stop(): Promise<void> {
    this.finishing = this.finish(false);
    await this.finishing;
  }

  async settled(): Promise<void> {
    await this.finishing;
  }

  dispose(): void {
    this.removeDeviceListener();
    this.removeDeviceListener = () => {};
    void this.stop();
  }

  private acceptFrame(frame: Float32Array): void {
    const source = this.source;
    const settings = this.settings;
    if (!source || !settings || frame.length === 0) return;
    const maximumSamples = Math.ceil(source.sampleRate * settings.maxListenMs / 1_000);
    const remaining = maximumSamples - this.sampleCount;
    if (remaining <= 0) {
      this.finishing = this.finish(true);
      return;
    }
    const accepted = frame.length <= remaining
      ? frame.slice()
      : frame.slice(0, remaining);
    this.chunks.push(accepted);
    this.sampleCount += accepted.length;
    if (!this.detector) return;
    const event = this.detector.feed({
      rms: rms(accepted),
      elapsedMs: this.sampleCount / source.sampleRate * 1_000,
    });
    if (event === 'endpoint' || event === 'max-duration') {
      this.finishing = this.finish(true);
    } else if (event === 'no-speech-timeout') {
      this.callbacks.onError('no-speech-timeout');
      this.finishing = this.finish(false);
    }
  }

  private async finish(submit: boolean): Promise<void> {
    this.generation += 1;
    this.opening = false;
    const source = this.source;
    if (!source) {
      this.clearAudio();
      return;
    }
    this.source = null;
    this.callbacks.onListeningChanged(false);
    const chunks = this.chunks;
    const count = this.sampleCount;
    this.clearAudio();
    await source.close();
    if (!submit || count === 0) return;
    const local = concatenate(chunks, count);
    const pcm = resample(local, source.sampleRate);
    const bytes = new Uint8Array(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
    );
    await this.callbacks.onEndpoint(bytes);
  }

  private clearAudio(): void {
    this.chunks = [];
    this.sampleCount = 0;
    this.detector = null;
  }

  private async checkSelectedDevice(): Promise<void> {
    if (!this.active || !this.selectedDevice || this.selectedDevice === 'default') return;
    const devices = await this.backend.listInputDevices();
    if (devices.some((device) => device.id === this.selectedDevice)) return;
    this.callbacks.onError('device-disconnected');
    await this.finish(false);
  }
}

class BrowserVoiceCaptureSource implements VoiceCaptureSource {
  readonly sampleRate: number;
  readonly deviceId: string;
  private processor?: ScriptProcessorNode;
  private input?: MediaStreamAudioSourceNode;
  private ended?: () => void;

  constructor(
    private readonly stream: MediaStream,
    private readonly context: AudioContext,
  ) {
    this.sampleRate = context.sampleRate;
    this.deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? 'default';
  }

  connect(
    onFrame: (samples: Float32Array) => void,
    onEnded: () => void,
  ): void {
    this.ended = onEnded;
    this.input = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4_096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      onFrame(event.inputBuffer.getChannelData(0));
    };
    this.stream.getAudioTracks().forEach((track) => {
      track.addEventListener('ended', onEnded, { once: true });
    });
    this.input.connect(this.processor);
    this.processor.connect(this.context.destination);
  }

  async close(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
    }
    this.input?.disconnect();
    this.stream.getAudioTracks().forEach((track) => {
      if (this.ended) track.removeEventListener('ended', this.ended);
      track.stop();
    });
    await this.context.close();
  }
}

export class BrowserVoiceCaptureBackend implements VoiceCaptureBackend {
  async listInputDevices(): Promise<VoiceInputDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId || 'default',
        label: device.label || `Microphone ${index + 1}`,
      }));
  }

  async open(deviceId: string): Promise<VoiceCaptureSource> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default'
          ? { exact: deviceId }
          : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    return new BrowserVoiceCaptureSource(stream, new AudioContext());
  }

  onDeviceChange(callback: () => void): () => void {
    navigator.mediaDevices?.addEventListener?.('devicechange', callback);
    return () => navigator.mediaDevices?.removeEventListener?.(
      'devicechange',
      callback,
    );
  }
}
