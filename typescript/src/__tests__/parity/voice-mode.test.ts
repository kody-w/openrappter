/**
 * Tests for VoiceMode — repetition detection, VIP answer, text similarity.
 *
 * ⚠️  EXPERIMENTAL feature tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  VoiceMode,
  computeTextSimilarity,
  extractCoreIntent,
  type VoiceTurn,
} from '../../voice/voice-mode.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTurn(text: string, durationMs = 2000): VoiceTurn {
  return {
    audio: Buffer.from(`audio-for-${text}`),
    transcription: { text },
    timestamp: Date.now(),
    durationMs,
  };
}

// ── Text similarity tests ────────────────────────────────────────────────────

describe('computeTextSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(computeTextSimilarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 1.0 for empty strings', () => {
    expect(computeTextSimilarity('', '')).toBe(1.0);
  });

  it('returns 0.0 when one string is empty', () => {
    expect(computeTextSimilarity('hello', '')).toBe(0.0);
    expect(computeTextSimilarity('', 'hello')).toBe(0.0);
  });

  it('returns high similarity for near-identical strings', () => {
    const sim = computeTextSimilarity('how do I reset my password', 'how do I reset my password?');
    expect(sim).toBeGreaterThan(0.9);
  });

  it('returns high similarity for rephrased versions', () => {
    const sim = computeTextSimilarity(
      'what is the weather today',
      'what is the weather for today'
    );
    expect(sim).toBeGreaterThan(0.7);
  });

  it('returns low similarity for different topics', () => {
    const sim = computeTextSimilarity(
      'how do I cook pasta',
      'explain quantum computing'
    );
    expect(sim).toBeLessThan(0.3);
  });

  it('is case insensitive', () => {
    const sim = computeTextSimilarity('Hello World', 'hello world');
    expect(sim).toBe(1.0);
  });

  it('ignores punctuation', () => {
    const sim = computeTextSimilarity('hello, world!', 'hello world');
    expect(sim).toBe(1.0);
  });
});

// ── Core intent extraction ───────────────────────────────────────────────────

describe('extractCoreIntent', () => {
  it('returns the longer text as primary', () => {
    const result = extractCoreIntent('reset password', 'how do I reset my password please');
    expect(result).toContain('how do I reset my password please');
  });

  it('identifies shared keywords', () => {
    const result = extractCoreIntent(
      'what is the weather forecast',
      'tell me the weather forecast today'
    );
    expect(result).toContain('weather');
    expect(result).toContain('forecast');
  });

  it('handles single-word inputs', () => {
    const result = extractCoreIntent('hello', 'hello');
    expect(result).toBeTruthy();
  });
});

// ── VoiceMode state machine ─────────────────────────────────────────────────

describe('VoiceMode', () => {
  let voiceMode: VoiceMode;

  beforeEach(() => {
    voiceMode = new VoiceMode({
      repetitionThreshold: 0.7,
      maxRetainedTurns: 5,
      vipAnswerMode: true,
    });
  });

  it('returns null for the first turn (no prior to compare)', () => {
    const result = voiceMode.processTurn(makeTurn('hello world'));
    expect(result).toBeNull();
  });

  it('returns null for different consecutive turns', () => {
    voiceMode.processTurn(makeTurn('what is the weather'));
    const result = voiceMode.processTurn(makeTurn('tell me about quantum physics'));
    expect(result).toBeNull();
  });

  it('detects repetition when user says the same thing', () => {
    voiceMode.processTurn(makeTurn('reset my password'));
    const result = voiceMode.processTurn(makeTurn('reset my password'));
    expect(result).not.toBeNull();
    expect(result!.isVip).toBe(true);
    expect(result!.analysis.isRepeating).toBe(true);
    expect(result!.analysis.similarity).toBe(1.0);
  });

  it('detects repetition for similar rephrased requests', () => {
    // Use a lower threshold to test rephrased detection
    const sensitive = new VoiceMode({ repetitionThreshold: 0.6, vipAnswerMode: true });
    sensitive.processTurn(makeTurn('how do I reset my password'));
    const result = sensitive.processTurn(makeTurn('how can I reset the password'));
    expect(result).not.toBeNull();
    expect(result!.isVip).toBe(true);
    expect(result!.analysis.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('provides both audio buffers in VIP context', () => {
    voiceMode.processTurn(makeTurn('reset password'));
    const result = voiceMode.processTurn(makeTurn('reset password'));
    expect(result).not.toBeNull();
    expect(result!.audioBuffers).toHaveLength(2);
    expect(result!.audioBuffers[0]).toBeInstanceOf(Buffer);
    expect(result!.audioBuffers[1]).toBeInstanceOf(Buffer);
  });

  it('provides system prompt supplement for VIP answer', () => {
    voiceMode.processTurn(makeTurn('reset password'));
    const result = voiceMode.processTurn(makeTurn('reset password'));
    expect(result).not.toBeNull();
    expect(result!.systemPromptSupplement).toContain('VIP ANSWER MODE');
    expect(result!.systemPromptSupplement).toContain('repeated');
    expect(result!.systemPromptSupplement).toContain('reset password');
  });

  it('tracks consecutive repetitions', () => {
    voiceMode.processTurn(makeTurn('help me'));
    voiceMode.processTurn(makeTurn('help me'));
    const result = voiceMode.processTurn(makeTurn('help me'));
    expect(result).not.toBeNull();
    expect(result!.analysis.consecutiveRepetitions).toBe(2);
  });

  it('resets repetition count after a different message', () => {
    voiceMode.processTurn(makeTurn('help me'));
    voiceMode.processTurn(makeTurn('help me'));
    voiceMode.processTurn(makeTurn('something completely different'));
    expect(voiceMode.getRepetitionCount()).toBe(0);
  });

  it('escalates urgency for multiple repetitions', () => {
    voiceMode.processTurn(makeTurn('fix the bug'));
    voiceMode.processTurn(makeTurn('fix the bug'));
    voiceMode.processTurn(makeTurn('fix the bug'));
    const result = voiceMode.processTurn(makeTurn('fix the bug'));
    expect(result).not.toBeNull();
    expect(result!.systemPromptSupplement).toContain('critical');
  });

  it('does not trigger VIP when vipAnswerMode is disabled', () => {
    const noVip = new VoiceMode({ vipAnswerMode: false, repetitionThreshold: 0.7 });
    noVip.processTurn(makeTurn('hello'));
    const result = noVip.processTurn(makeTurn('hello'));
    expect(result).toBeNull();
    // But the repetition count should still increase
    expect(noVip.getRepetitionCount()).toBe(1);
  });

  it('respects maxRetainedTurns', () => {
    const small = new VoiceMode({ maxRetainedTurns: 2 });
    small.processTurn(makeTurn('one'));
    small.processTurn(makeTurn('two'));
    small.processTurn(makeTurn('three'));
    expect(small.getRecentTurns()).toHaveLength(2);
  });

  it('getStatus returns correct info', () => {
    voiceMode.processTurn(makeTurn('hello'));
    const status = voiceMode.getStatus();
    expect(status.turnsStored).toBe(1);
    expect(status.consecutiveRepetitions).toBe(0);
    expect(status.config.repetitionThreshold).toBe(0.7);
  });

  it('clear resets all state', () => {
    voiceMode.processTurn(makeTurn('hello'));
    voiceMode.processTurn(makeTurn('hello'));
    voiceMode.clear();
    expect(voiceMode.getRecentTurns()).toHaveLength(0);
    expect(voiceMode.getRepetitionCount()).toBe(0);
  });

  it('combined text includes both turns', () => {
    voiceMode.processTurn(makeTurn('first message'));
    const result = voiceMode.processTurn(makeTurn('first message'));
    expect(result).not.toBeNull();
    expect(result!.analysis.combinedText).toContain('[Turn 1]');
    expect(result!.analysis.combinedText).toContain('[Turn 2]');
    expect(result!.analysis.combinedText).toContain('first message');
  });
});
