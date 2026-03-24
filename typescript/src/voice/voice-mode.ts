/**
 * VoiceMode — Local on-device voice processing with repetition detection.
 *
 * ⚠️  EXPERIMENTAL: Subject to change. Use at your own risk.
 *
 * Architecture inspired by Handy (github.com/cjpais/Handy):
 * - Local Whisper (whisper.cpp) for speech-to-text
 * - Silero VAD for voice activity detection
 * - Audio buffer retention between turns for repetition analysis
 *
 * When the user repeats themselves, both audio buffers and transcriptions
 * are combined to generate a "VIP answer" — a high-confidence, trust-building
 * response that acknowledges the repetition and addresses the core intent.
 */

import type { TranscriptionResult } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface VoiceTurn {
  /** Raw audio buffer (WAV/PCM) */
  audio: Buffer;
  /** Transcription result from STT engine */
  transcription: TranscriptionResult;
  /** Timestamp when this turn was recorded */
  timestamp: number;
  /** Duration in milliseconds */
  durationMs: number;
}

export interface RepetitionAnalysis {
  /** Whether the user is repeating themselves */
  isRepeating: boolean;
  /** Similarity score between consecutive turns (0.0–1.0) */
  similarity: number;
  /** The core intent extracted from both turns */
  coreIntent: string;
  /** Combined transcription text for VIP answer context */
  combinedText: string;
  /** Number of consecutive repetitions detected */
  consecutiveRepetitions: number;
}

export interface VipContext {
  /** Whether this response should be a VIP answer */
  isVip: boolean;
  /** The repetition analysis that triggered VIP mode */
  analysis: RepetitionAnalysis;
  /** Both audio buffers for the repeated turns */
  audioBuffers: Buffer[];
  /** System prompt supplement for generating the VIP answer */
  systemPromptSupplement: string;
}

export interface VoiceModeConfig {
  /** Similarity threshold for detecting repetition (0.0–1.0) */
  repetitionThreshold?: number;
  /** Maximum number of turns to retain */
  maxRetainedTurns?: number;
  /** Enable VIP answer mode */
  vipAnswerMode?: boolean;
  /** Enable VAD filtering */
  vad?: boolean;
  /** VAD threshold */
  vadThreshold?: number;
}

// ── Text similarity ──────────────────────────────────────────────────────────

/**
 * Compute similarity between two strings using word overlap (Jaccard index)
 * and Levenshtein-based character similarity.
 */
export function computeTextSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;

  const normalizeText = (t: string) =>
    t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

  const na = normalizeText(a);
  const nb = normalizeText(b);

  if (na === nb) return 1.0;
  if (!na || !nb) return 0.0;

  // Word-level Jaccard similarity
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  const jaccard = union.size > 0 ? intersection.size / union.size : 0;

  // Character-level similarity (normalized edit distance)
  const maxLen = Math.max(na.length, nb.length);
  const editDist = levenshteinDistance(na, nb);
  const charSim = maxLen > 0 ? 1 - editDist / maxLen : 1;

  // Weighted combination: word overlap matters more for natural speech
  return 0.6 * jaccard + 0.4 * charSim;
}

/** Levenshtein edit distance */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row DP for memory efficiency
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }

  return prev[n];
}

// ── Core intent extraction ───────────────────────────────────────────────────

/**
 * Extract the core intent from two similar transcriptions.
 * Takes the longer transcription as the more complete version,
 * then identifies shared key phrases.
 */
export function extractCoreIntent(textA: string, textB: string): string {
  const normalize = (t: string) =>
    t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

  const na = normalize(textA);
  const nb = normalize(textB);

  // Use the longer text as the primary intent
  const primary = na.length >= nb.length ? textA.trim() : textB.trim();

  // Find common significant words (>3 chars, not stopwords)
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'that', 'this', 'these', 'those', 'it', 'its', 'and', 'but', 'or',
    'not', 'no', 'just', 'very', 'really', 'quite', 'also', 'too',
    'i', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'them',
  ]);

  const wordsA = new Set(na.split(' ').filter(w => w.length > 3 && !stopwords.has(w)));
  const wordsB = new Set(nb.split(' ').filter(w => w.length > 3 && !stopwords.has(w)));
  const shared = [...wordsA].filter(w => wordsB.has(w));

  if (shared.length > 0) {
    return `${primary} [key: ${shared.join(', ')}]`;
  }

  return primary;
}

// ── VoiceMode state machine ──────────────────────────────────────────────────

export class VoiceMode {
  private turns: VoiceTurn[] = [];
  private consecutiveRepetitions = 0;
  private config: Required<VoiceModeConfig>;

  constructor(config?: VoiceModeConfig) {
    this.config = {
      repetitionThreshold: config?.repetitionThreshold ?? 0.7,
      maxRetainedTurns: config?.maxRetainedTurns ?? 5,
      vipAnswerMode: config?.vipAnswerMode ?? true,
      vad: config?.vad ?? true,
      vadThreshold: config?.vadThreshold ?? 0.5,
    };
  }

  /**
   * Process a new voice turn. Returns VIP context if repetition is detected.
   */
  processTurn(turn: VoiceTurn): VipContext | null {
    const previousTurn = this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
    this.turns.push(turn);

    // Trim retained turns to max
    while (this.turns.length > this.config.maxRetainedTurns) {
      this.turns.shift();
    }

    if (!previousTurn) {
      this.consecutiveRepetitions = 0;
      return null;
    }

    const analysis = this.analyzeRepetition(previousTurn, turn);

    if (analysis.isRepeating) {
      this.consecutiveRepetitions++;
      analysis.consecutiveRepetitions = this.consecutiveRepetitions;

      if (this.config.vipAnswerMode) {
        return {
          isVip: true,
          analysis,
          audioBuffers: [previousTurn.audio, turn.audio],
          systemPromptSupplement: this.buildVipPrompt(analysis),
        };
      }
    } else {
      this.consecutiveRepetitions = 0;
    }

    return null;
  }

  /**
   * Analyze whether two consecutive turns represent repetition.
   */
  analyzeRepetition(prev: VoiceTurn, curr: VoiceTurn): RepetitionAnalysis {
    const prevText = prev.transcription.text;
    const currText = curr.transcription.text;
    const similarity = computeTextSimilarity(prevText, currText);
    const isRepeating = similarity >= this.config.repetitionThreshold;

    return {
      isRepeating,
      similarity,
      coreIntent: isRepeating ? extractCoreIntent(prevText, currText) : currText,
      combinedText: `[Turn 1]: ${prevText}\n[Turn 2]: ${currText}`,
      consecutiveRepetitions: isRepeating ? this.consecutiveRepetitions + 1 : 0,
    };
  }

  /**
   * Build a VIP answer system prompt supplement.
   * This is injected into the LLM context to produce a trust-building response.
   */
  private buildVipPrompt(analysis: RepetitionAnalysis): string {
    const reps = analysis.consecutiveRepetitions;
    const urgency = reps >= 3 ? 'critical' : reps >= 2 ? 'high' : 'elevated';

    return [
      `[VIP ANSWER MODE — ${urgency} priority]`,
      '',
      'The user has repeated their request. This signals that:',
      '1. The previous response did not fully address their need',
      '2. This topic is important to them and they need a definitive answer',
      '3. They may be frustrated — respond with extra care and precision',
      '',
      `Repetitions detected: ${reps}`,
      `Similarity score: ${(analysis.similarity * 100).toFixed(0)}%`,
      `Core intent: ${analysis.coreIntent}`,
      '',
      'Instructions for this response:',
      '- Lead with the direct answer — no preamble',
      '- Be more thorough and specific than usual',
      '- If the previous answer was incomplete, acknowledge that and expand',
      '- Show that you understood what they were really asking',
      '- If actionable steps are needed, provide them concretely',
      '',
      'Both transcriptions for context:',
      analysis.combinedText,
    ].join('\n');
  }

  /** Get the last N turns */
  getRecentTurns(n?: number): VoiceTurn[] {
    const count = n ?? this.turns.length;
    return this.turns.slice(-count);
  }

  /** Get the current repetition count */
  getRepetitionCount(): number {
    return this.consecutiveRepetitions;
  }

  /** Clear all stored turns */
  clear(): void {
    this.turns = [];
    this.consecutiveRepetitions = 0;
  }

  /** Get status info */
  getStatus(): { turnsStored: number; consecutiveRepetitions: number; config: Required<VoiceModeConfig> } {
    return {
      turnsStored: this.turns.length,
      consecutiveRepetitions: this.consecutiveRepetitions,
      config: { ...this.config },
    };
  }
}
