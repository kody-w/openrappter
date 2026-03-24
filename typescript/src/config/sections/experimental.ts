/**
 * Experimental features configuration schema.
 *
 * ⚠️  EXPERIMENTAL: These features are subject to change, may be unstable,
 * and could be removed in future versions. Use at your own risk.
 */

import { z } from 'zod';

const voiceModeDefaults = {
  enabled: false,
  engine: 'whisper' as const,
  modelSize: 'base' as const,
  vad: true,
  vadThreshold: 0.5,
  saveAudioBetweenTurns: true,
  repetitionDetection: true,
  repetitionThreshold: 0.7,
  vipAnswerMode: true,
};

const tuiBarDefaults = {
  enabled: false,
  refreshInterval: 2000,
  showAgents: true,
  showExperimentalPanel: true,
};

export const experimentalConfigSchema = z.object({
  /** Master toggle — disables all experimental features when false */
  enabled: z.boolean().default(false),

  /** Local on-device voice-to-text (Whisper / Vosk) */
  voiceMode: z.object({
    enabled: z.boolean().default(false),
    /** STT engine: 'whisper' (whisper.cpp), 'vosk', or 'apple' (macOS Speech framework) */
    engine: z.enum(['whisper', 'vosk', 'apple']).default('whisper'),
    /** Path to whisper model or vosk model directory */
    modelPath: z.string().optional(),
    /** Path to whisper/vosk binary (auto-detected if not set) */
    execPath: z.string().optional(),
    /** Whisper model size (tiny, base, small, medium, large) */
    modelSize: z.enum(['tiny', 'base', 'small', 'medium', 'large']).default('base'),
    /** Enable Voice Activity Detection (VAD) to filter silence */
    vad: z.boolean().default(true),
    /** VAD threshold (0.0–1.0, higher = stricter) */
    vadThreshold: z.number().min(0).max(1).default(0.5),
    /** Save raw audio buffers between turns for comparison */
    saveAudioBetweenTurns: z.boolean().default(true),
    /** Enable repetition detection (compares consecutive turns) */
    repetitionDetection: z.boolean().default(true),
    /** Similarity threshold for detecting repetition (0.0–1.0) */
    repetitionThreshold: z.number().min(0).max(1).default(0.7),
    /** Enable VIP answer mode when repetition is detected */
    vipAnswerMode: z.boolean().default(true),
  }).default(voiceModeDefaults),

  /** TUI-based OpenRappter Bar */
  tuiBar: z.object({
    enabled: z.boolean().default(false),
    /** Refresh interval in ms for status updates */
    refreshInterval: z.number().default(2000),
    /** Show agent status panel */
    showAgents: z.boolean().default(true),
    /** Show experimental features toggle panel */
    showExperimentalPanel: z.boolean().default(true),
  }).default(tuiBarDefaults),
});

export type ExperimentalConfig = z.infer<typeof experimentalConfigSchema>;

/** Human-readable descriptions for UI rendering */
export const experimentalFeatureDescriptions: Record<string, { name: string; description: string; risk: string }> = {
  voiceMode: {
    name: 'Local Voice Mode',
    description: 'On-device speech-to-text using Whisper/Vosk. No audio leaves your machine.',
    risk: 'Requires ~1GB model download. CPU-intensive during transcription.',
  },
  tuiBar: {
    name: 'TUI Bar',
    description: 'Terminal-based OpenRappter dashboard with status, agents, and chat.',
    risk: 'Layout may be unstable on some terminal emulators.',
  },
};
