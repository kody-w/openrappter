import type { VoiceProviderId } from './types.js';

export const ALLOWED_PUSH_TO_TALK_KEYS = [
  'Space',
  'KeyV',
  'KeyT',
  'ControlRight',
  'AltRight',
] as const;

export type PushToTalkKey = typeof ALLOWED_PUSH_TO_TALK_KEYS[number];
export type TranscriptPolicy = 'auto' | 'review';
export type BackgroundVoiceBehavior = 'pause';
export type WakeLockPolicy = 'never' | 'while-listening';

export interface GrailVoiceSettings {
  readonly outputEnabled: boolean;
  readonly autoSpeak: boolean;
  readonly provider: VoiceProviderId;
  readonly ttsVoice?: string;
  readonly ttsModel?: string;
  readonly inputEnabled: boolean;
  readonly continuousConversation: boolean;
  readonly pushToTalkKey: PushToTalkKey;
  readonly inputDeviceId: string;
  readonly transcriptPolicy: TranscriptPolicy;
  readonly backgroundBehavior: BackgroundVoiceBehavior;
  readonly wakeLock: WakeLockPolicy;
  readonly silenceMs: number;
  readonly noSpeechTimeoutMs: number;
  readonly maxListenMs: number;
  readonly vadThreshold: number;
  readonly operationTimeoutMs: number;
  readonly thinkingTimeoutMs: number;
}

export const DEFAULT_GRAIL_VOICE_SETTINGS: GrailVoiceSettings = Object.freeze({
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
});

export interface GrailVoiceReviewContext {
  reservedKeys?: readonly string[];
  availableInputDeviceIds?: readonly string[];
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function bounded(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function safeId(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string') return fallback;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/.test(value) ? value : fallback;
}

export function reviewGrailVoiceSettings(
  candidate: Partial<GrailVoiceSettings>,
  context: GrailVoiceReviewContext = {},
): GrailVoiceSettings {
  const provider = candidate.provider;
  if (provider !== 'system' && provider !== 'local' && provider !== 'elevenlabs') {
    throw new Error('Voice provider must be system, local, or elevenlabs.');
  }
  const pushToTalkKey = candidate.pushToTalkKey;
  if (
    typeof pushToTalkKey !== 'string'
    || !ALLOWED_PUSH_TO_TALK_KEYS.includes(pushToTalkKey as PushToTalkKey)
  ) {
    throw new Error('Push-to-talk key is not an allowed closed choice.');
  }
  if (context.reservedKeys?.includes(pushToTalkKey)) {
    throw new Error('Push-to-talk key conflicts with an application shortcut.');
  }
  const inputDeviceId = safeId(candidate.inputDeviceId, 'default') ?? 'default';
  if (
    context.availableInputDeviceIds
    && !context.availableInputDeviceIds.includes(inputDeviceId)
  ) {
    throw new Error('Selected input device is disconnected or unavailable.');
  }
  const transcriptPolicy = candidate.transcriptPolicy;
  if (transcriptPolicy !== 'auto' && transcriptPolicy !== 'review') {
    throw new Error('Transcript policy must be auto or review.');
  }
  if (candidate.backgroundBehavior !== 'pause') {
    throw new Error('Voice capture must pause in the background.');
  }
  if (candidate.wakeLock !== 'never' && candidate.wakeLock !== 'while-listening') {
    throw new Error('Invalid wake-lock policy.');
  }
  return Object.freeze({
    outputEnabled: boolean(candidate.outputEnabled, false),
    autoSpeak: boolean(candidate.autoSpeak, false),
    provider,
    ttsVoice: safeId(candidate.ttsVoice),
    ttsModel: safeId(candidate.ttsModel),
    inputEnabled: boolean(candidate.inputEnabled, false),
    continuousConversation: boolean(candidate.continuousConversation, false),
    pushToTalkKey: pushToTalkKey as PushToTalkKey,
    inputDeviceId,
    transcriptPolicy,
    backgroundBehavior: 'pause',
    wakeLock: candidate.wakeLock,
    silenceMs: bounded(candidate.silenceMs, 800, 400, 2_000),
    noSpeechTimeoutMs: bounded(
      candidate.noSpeechTimeoutMs,
      10_000,
      2_000,
      30_000,
    ),
    maxListenMs: bounded(candidate.maxListenMs, 30_000, 5_000, 45_000),
    vadThreshold: bounded(candidate.vadThreshold, 0.025, 0.005, 0.2),
    operationTimeoutMs: bounded(
      candidate.operationTimeoutMs,
      30_000,
      1_000,
      60_000,
    ),
    thinkingTimeoutMs: bounded(
      candidate.thinkingTimeoutMs,
      120_000,
      10_000,
      180_000,
    ),
  });
}

/** Persistence allowlist: credential material cannot enter this object. */
export function serializeGrailVoiceSettings(settings: GrailVoiceSettings): string {
  const safe: GrailVoiceSettings = {
    outputEnabled: settings.outputEnabled,
    autoSpeak: settings.autoSpeak,
    provider: settings.provider,
    ttsVoice: settings.ttsVoice,
    ttsModel: settings.ttsModel,
    inputEnabled: settings.inputEnabled,
    continuousConversation: settings.continuousConversation,
    pushToTalkKey: settings.pushToTalkKey,
    inputDeviceId: settings.inputDeviceId,
    transcriptPolicy: settings.transcriptPolicy,
    backgroundBehavior: settings.backgroundBehavior,
    wakeLock: settings.wakeLock,
    silenceMs: settings.silenceMs,
    noSpeechTimeoutMs: settings.noSpeechTimeoutMs,
    maxListenMs: settings.maxListenMs,
    vadThreshold: settings.vadThreshold,
    operationTimeoutMs: settings.operationTimeoutMs,
    thinkingTimeoutMs: settings.thinkingTimeoutMs,
  };
  return JSON.stringify(safe);
}

/**
 * Default shell-neutral Grail seam. Pending shells consume this reviewed
 * snapshot rather than owning microphone, credential, or provider logic.
 */
export class DefaultGrailVoiceIntegrationAdapter {
  private committed: GrailVoiceSettings;

  constructor(initial: Partial<GrailVoiceSettings> = DEFAULT_GRAIL_VOICE_SETTINGS) {
    this.committed = reviewGrailVoiceSettings({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      ...initial,
    });
  }

  get settings(): GrailVoiceSettings {
    return this.committed;
  }

  reviewAndCommit(
    draft: Partial<GrailVoiceSettings>,
    context?: GrailVoiceReviewContext,
  ): GrailVoiceSettings {
    this.committed = reviewGrailVoiceSettings({
      ...this.committed,
      ...draft,
    }, context);
    return this.committed;
  }

  discardDraft(): GrailVoiceSettings {
    return this.committed;
  }

  serialize(): string {
    return serializeGrailVoiceSettings(this.committed);
  }
}
