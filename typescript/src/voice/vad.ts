export type VadEvent =
  | 'calibrating'
  | 'silence'
  | 'speech'
  | 'endpoint'
  | 'no-speech-timeout'
  | 'max-duration';

export interface VadFrame {
  rms: number;
  elapsedMs: number;
}

export interface VadEndpointOptions {
  calibrationMs?: number;
  minSpeechMs?: number;
  silenceMs?: number;
  noSpeechTimeoutMs?: number;
  maxListenMs?: number;
  absoluteThreshold?: number;
  noiseMultiplier?: number;
}

export class VadEndpointDetector {
  private readonly calibrationMs: number;
  private readonly minSpeechMs: number;
  private readonly silenceMs: number;
  private readonly noSpeechTimeoutMs: number;
  private readonly maxListenMs: number;
  private readonly absoluteThreshold: number;
  private readonly noiseMultiplier: number;
  private baselineTotal = 0;
  private baselineFrames = 0;
  private speechStartedAt: number | null = null;
  private lastSpeechAt: number | null = null;

  constructor(options: VadEndpointOptions = {}) {
    this.calibrationMs = options.calibrationMs ?? 300;
    this.minSpeechMs = options.minSpeechMs ?? 250;
    this.silenceMs = options.silenceMs ?? 800;
    this.noSpeechTimeoutMs = options.noSpeechTimeoutMs ?? 10_000;
    this.maxListenMs = options.maxListenMs ?? 30_000;
    this.absoluteThreshold = options.absoluteThreshold ?? 0.025;
    this.noiseMultiplier = options.noiseMultiplier ?? 2.5;
  }

  feed(frame: VadFrame): VadEvent {
    if (
      !Number.isFinite(frame.rms)
      || frame.rms < 0
      || !Number.isFinite(frame.elapsedMs)
      || frame.elapsedMs < 0
    ) {
      return 'silence';
    }
    if (frame.elapsedMs > this.maxListenMs) return 'max-duration';
    if (frame.elapsedMs < this.calibrationMs) {
      this.baselineTotal += frame.rms;
      this.baselineFrames += 1;
      return 'calibrating';
    }
    const baseline = this.baselineFrames > 0
      ? this.baselineTotal / this.baselineFrames
      : 0;
    const threshold = Math.max(
      this.absoluteThreshold,
      baseline * this.noiseMultiplier,
    );
    if (frame.rms >= threshold) {
      this.speechStartedAt ??= frame.elapsedMs;
      this.lastSpeechAt = frame.elapsedMs;
      return 'speech';
    }
    if (this.speechStartedAt === null) {
      return frame.elapsedMs > this.noSpeechTimeoutMs
        ? 'no-speech-timeout'
        : 'silence';
    }
    const meaningfulSpeech =
      (this.lastSpeechAt ?? frame.elapsedMs) - this.speechStartedAt
      >= this.minSpeechMs;
    if (
      meaningfulSpeech
      && frame.elapsedMs - (this.lastSpeechAt ?? frame.elapsedMs) > this.silenceMs
    ) {
      return 'endpoint';
    }
    return 'silence';
  }
}
