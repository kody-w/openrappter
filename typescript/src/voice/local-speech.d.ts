/**
 * Types for the shared speech seam.
 *
 * The implementation is plain JavaScript on purpose — the anatomy page and the
 * vbrainstem are single-file surfaces that inline the same bytes this module
 * exports, so there is one implementation rather than a TypeScript original and
 * a hand-copied twin that drifts.
 */

export type SpeechState =
  | 'idle'
  | 'speaking'
  | 'spoke'
  | 'not-available'
  | 'blocked-or-unknown';

export declare const SPEECH_STATES: {
  readonly IDLE: 'idle';
  readonly SPEAKING: 'speaking';
  readonly SPOKE: 'spoke';
  readonly UNAVAILABLE: 'not-available';
  readonly BLOCKED: 'blocked-or-unknown';
};

export interface SpeechDetail {
  reason?: string;
  voice?: string;
  text?: string;
  localVoices?: number;
  networkVoices?: number;
}

export interface SpeechStatus {
  state: SpeechState;
  detail: SpeechDetail;
  enabled: boolean;
  voice: { name: string; lang: string } | null;
  localVoices: number;
  networkVoices: number;
}

export interface SpeechResult {
  state: SpeechState;
  detail: SpeechDetail;
}

export interface LocalSpeechOptions {
  storage?: Storage | null;
  storageKey?: string;
  synth?: SpeechSynthesis | null;
  Utterance?: typeof SpeechSynthesisUtterance | null;
  onState?: (state: SpeechState, detail: SpeechDetail) => void;
  lang?: string;
  /** Watchdog for an utterance the engine accepted but never started. */
  startTimeoutMs?: number;
  /** How long to wait for `voiceschanged` before answering "no voices". */
  voicesTimeoutMs?: number;
}

export interface LocalSpeech {
  readonly SPEECH_STATES: typeof SPEECH_STATES;
  readonly state: SpeechState;
  readonly detail: SpeechDetail;
  readonly enabled: boolean;
  readonly voice: SpeechSynthesisVoice | null;
  /** Only voices with `localService === true`. Never a network voice. */
  readonly localVoices: SpeechSynthesisVoice[];
  /** Record a real user gesture; browsers drop speech started without one. */
  noteUserGesture(): void;
  setEnabled(value: boolean): boolean;
  ready(): Promise<SpeechStatus>;
  status(): SpeechStatus;
  stop(): void;
  /**
   * Speak `voice_response` — never `response`.
   * Resolves `spoke` only when the engine fires its own `end` event.
   */
  speak(text: string): Promise<SpeechResult>;
}

export declare function createLocalSpeech(options?: LocalSpeechOptions): LocalSpeech;

/**
 * Pull the spoken half out of a `/chat` envelope or streaming event.
 * Returns `null` rather than falling back to `response`.
 */
export declare function spokenLineFrom(envelope: unknown): string | null;

/**
 * Derive a spoken line from a raw, unsplit reply — the same rule the gateway
 * applies server-side, so a surface talking straight to a model speaks the same
 * half of the same reply.
 */
export declare function deriveSpokenLine(raw: string): string | null;
