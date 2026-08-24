import { describe, expect, it } from 'vitest';
import { VadEndpointDetector } from './vad.js';

describe('bounded VAD and silence endpointing', () => {
  it('endpoints after meaningful speech followed by configured silence', () => {
    const vad = new VadEndpointDetector({
      calibrationMs: 200,
      minSpeechMs: 200,
      silenceMs: 600,
      noSpeechTimeoutMs: 5_000,
      maxListenMs: 10_000,
      absoluteThreshold: 0.02,
    });
    expect(vad.feed({ rms: 0.005, elapsedMs: 100 })).toBe('calibrating');
    expect(vad.feed({ rms: 0.006, elapsedMs: 200 })).toBe('silence');
    expect(vad.feed({ rms: 0.12, elapsedMs: 300 })).toBe('speech');
    expect(vad.feed({ rms: 0.11, elapsedMs: 500 })).toBe('speech');
    expect(vad.feed({ rms: 0.004, elapsedMs: 800 })).toBe('silence');
    expect(vad.feed({ rms: 0.004, elapsedMs: 1_101 })).toBe('endpoint');
  });

  it('times out without speech in a calibrated noisy room', () => {
    const vad = new VadEndpointDetector({
      calibrationMs: 300,
      minSpeechMs: 200,
      silenceMs: 600,
      noSpeechTimeoutMs: 1_000,
      maxListenMs: 2_000,
      absoluteThreshold: 0.02,
      noiseMultiplier: 2.5,
    });
    expect(vad.feed({ rms: 0.08, elapsedMs: 100 })).toBe('calibrating');
    expect(vad.feed({ rms: 0.08, elapsedMs: 300 })).toBe('silence');
    expect(vad.feed({ rms: 0.09, elapsedMs: 1_001 })).toBe('no-speech-timeout');
  });

  it('caps a continuously noisy or speaking capture', () => {
    const vad = new VadEndpointDetector({
      calibrationMs: 100,
      minSpeechMs: 100,
      silenceMs: 500,
      noSpeechTimeoutMs: 4_000,
      maxListenMs: 1_000,
      absoluteThreshold: 0.01,
    });
    vad.feed({ rms: 0.001, elapsedMs: 100 });
    vad.feed({ rms: 0.2, elapsedMs: 300 });
    expect(vad.feed({ rms: 0.2, elapsedMs: 1_001 })).toBe('max-duration');
  });
});
