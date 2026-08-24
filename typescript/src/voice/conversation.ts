import type { GrailVoiceSettings, PushToTalkKey } from './grail-adapter.js';

export type VoiceConversationState =
  | 'idle'
  | 'listening'
  | 'endpointing'
  | 'transcribing'
  | 'sending'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'cancelled'
  | 'error'
  | 'offline'
  | 'auth'
  | 'model-unavailable';

export interface VoiceConversationSnapshot {
  readonly state: VoiceConversationState;
  readonly reason?: string;
  readonly transcript?: string;
  readonly runId?: string;
  readonly approvalId?: string;
  readonly turn: number;
}

export interface VoiceConversationClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface VoiceAssistantOutput {
  runId: string;
  text: string;
  ticket?: string;
}

export interface VoiceConversationDependencies {
  transcribeLocal(audio: Uint8Array, signal: AbortSignal): Promise<string>;
  showTranscript(text: string, requiresConfirmation: boolean): void;
  sendTranscript(
    text: string,
    signal: AbortSignal,
  ): Promise<{ runId: string }>;
  speakAssistant(
    output: VoiceAssistantOutput,
    signal: AbortSignal,
  ): Promise<void>;
  cancelSpeech(): Promise<void>;
  stopCapture(): Promise<void>;
  onState(snapshot: VoiceConversationSnapshot): void;
}

const defaultClock: VoiceConversationClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function normalizedWords(value: string): Set<string> {
  return new Set(
    value.toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function similar(left: string, right: string): boolean {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (a.size === 0 || b.size === 0) return false;
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union >= 0.8;
}

function failureState(error: unknown): VoiceConversationState {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'offline') return 'offline';
  if (code === 'invalid_key' || code === 'auth') return 'auth';
  if (code === 'model_unavailable' || code === 'model-unavailable') {
    return 'model-unavailable';
  }
  const message = (error as Error)?.message?.toLowerCase() ?? '';
  if (/offline|unreachable|network/.test(message)) return 'offline';
  if (/credential|invalid key|authentication|unauthorized/.test(message)) {
    return 'auth';
  }
  if (/model.*unavailable|selected model/.test(message)) {
    return 'model-unavailable';
  }
  return 'error';
}

export class GrailVoiceConversation {
  private current: VoiceConversationSnapshot = { state: 'idle', turn: 0 };
  private generation = 0;
  private activeOperation: AbortController | null = null;
  private turnActive = false;
  private pendingTranscript = '';
  private thinkingTimer: unknown;
  private spoken: { text: string; at: number } | null = null;
  private pausedRunId = '';
  private pausedTranscript = '';
  private readonly ownedRunIds = new Set<string>();
  private deferredAssistant?: VoiceAssistantOutput;

  constructor(
    private settings: GrailVoiceSettings,
    private readonly dependencies: VoiceConversationDependencies,
    private readonly clock: VoiceConversationClock = defaultClock,
  ) {
    this.dependencies.onState(this.current);
  }

  get snapshot(): VoiceConversationSnapshot {
    return this.current;
  }

  updateSettings(settings: GrailVoiceSettings): void {
    this.settings = settings;
    if (!settings.inputEnabled && this.current.state === 'listening') {
      void this.pause('input-disabled');
    }
  }

  async beginListening(
    reason: 'continuous' | 'push-to-talk' | 'manual' | 'barge-in',
  ): Promise<void> {
    if (!this.settings.inputEnabled) throw new Error('Voice input is disabled.');
    if (
      this.current.state === 'paused'
      && this.current.reason === 'tool-approval'
    ) {
      throw new Error('A tool approval is pending.');
    }
    if (this.current.state === 'speaking') {
      this.generation += 1;
      this.activeOperation?.abort();
      await this.dependencies.cancelSpeech();
    } else if (
      this.turnActive
      && this.current.state !== 'idle'
      && this.current.state !== 'cancelled'
    ) {
      throw new Error('A voice turn is already active.');
    }
    this.turnActive = false;
    this.emit('listening', reason);
  }

  async pushToTalkPressed(key: PushToTalkKey): Promise<void> {
    if (key !== this.settings.pushToTalkKey) {
      throw new Error('Push-to-talk key does not match the reviewed setting.');
    }
    await this.beginListening('push-to-talk');
  }

  async pushToTalkReleased(audio: Uint8Array): Promise<void> {
    await this.submitEndpoint(audio);
  }

  async submitEndpoint(audio: Uint8Array): Promise<void> {
    if (this.turnActive) throw new Error('A voice turn is already active.');
    if (this.current.state !== 'listening') {
      throw new Error('Voice input is not listening.');
    }
    if (audio.byteLength === 0 || audio.byteLength > 45 * 16_000 * 4) {
      this.fail('audio-bounds');
      return;
    }
    this.turnActive = true;
    const generation = ++this.generation;
    this.emit('endpointing');
    await this.dependencies.stopCapture();
    if (generation !== this.generation) return;
    this.emit('transcribing');
    const controller = new AbortController();
    this.activeOperation = controller;
    let transcript: string;
    try {
      transcript = (
        await this.withTimeout(
          this.dependencies.transcribeLocal(audio, controller.signal),
          this.settings.operationTimeoutMs,
          'transcription-timeout',
          () => controller.abort(),
        )
      ).trim().slice(0, 8_000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.turnActive = false;
      this.emit(
        failureState(error),
        (error as Error).message || 'transcription-failed',
      );
      return;
    } finally {
      if (this.activeOperation === controller) this.activeOperation = null;
    }
    if (generation !== this.generation) return;
    if (!transcript) {
      this.turnActive = false;
      await this.restartOrIdle('empty-transcript');
      return;
    }
    if (
      this.spoken
      && this.clock.now() - this.spoken.at <= 15_000
      && similar(transcript, this.spoken.text)
    ) {
      this.turnActive = false;
      await this.restartOrIdle('echo-suppressed');
      return;
    }
    this.pendingTranscript = transcript;
    const review = this.settings.transcriptPolicy === 'review';
    this.dependencies.showTranscript(transcript, review);
    if (review) {
      this.emit('paused', 'transcript-review', { transcript });
      return;
    }
    await this.dispatchTranscript(transcript, generation);
  }

  async confirmTranscript(): Promise<void> {
    if (
      this.current.state !== 'paused'
      || this.current.reason !== 'transcript-review'
      || !this.pendingTranscript
    ) {
      throw new Error('No transcript is awaiting confirmation.');
    }
    await this.dispatchTranscript(this.pendingTranscript, this.generation);
  }

  async assistantFinal(output: VoiceAssistantOutput): Promise<boolean> {
    if (
      this.current.state === 'paused'
      && this.current.reason === 'tool-approval'
      && output.runId === this.pausedRunId
    ) {
      this.deferredAssistant = output;
      return true;
    }
    if (
      this.current.state !== 'thinking'
      || !this.current.runId
      || output.runId !== this.current.runId
    ) {
      if (this.ownedRunIds.delete(output.runId)) return true;
      return false;
    }
    this.ownedRunIds.delete(output.runId);
    this.clearThinkingTimer();
    const generation = this.generation;
    if (
      this.settings.outputEnabled
      && this.settings.autoSpeak
      && output.text.trim()
    ) {
      this.noteSpokenText(output.text);
      this.emit('speaking', undefined, { runId: output.runId });
      const controller = new AbortController();
      this.activeOperation = controller;
      try {
        await this.withTimeout(
          this.dependencies.speakAssistant(output, controller.signal),
          this.settings.operationTimeoutMs,
          'speech-timeout',
          () => controller.abort(),
        );
      } catch (error) {
        if (generation !== this.generation) return true;
        this.turnActive = false;
        this.emit(failureState(error), (error as Error).message || 'speech-failed');
        return true;
      } finally {
        if (this.activeOperation === controller) this.activeOperation = null;
      }
    }
    if (generation !== this.generation) return true;
    this.turnActive = false;
    this.pendingTranscript = '';
    await this.restartOrIdle('response-complete');
    return true;
  }

  noteSpokenText(text: string): void {
    this.spoken = { text, at: this.clock.now() };
  }

  assistantFailed(runId: string, code: string): boolean {
    if (this.current.state !== 'thinking' || this.current.runId !== runId) {
      return false;
    }
    this.ownedRunIds.delete(runId);
    if (code === 'cancelled') {
      this.generation += 1;
      this.turnActive = false;
      this.clearThinkingTimer();
      this.emit('cancelled', code);
    } else {
      this.fail(code);
    }
    return true;
  }

  fail(
    code: 'offline' | 'auth' | 'model-unavailable' | string,
  ): void {
    this.generation += 1;
    this.turnActive = false;
    this.activeOperation?.abort();
    this.activeOperation = null;
    this.clearThinkingTimer();
    const state = code === 'offline'
      ? 'offline'
      : code === 'auth'
        ? 'auth'
        : code === 'model-unavailable'
          ? 'model-unavailable'
          : 'error';
    this.emit(state, code);
  }

  async approvalRequested(approvalId: string): Promise<void> {
    this.pausedRunId = this.current.state === 'thinking'
      ? this.current.runId ?? ''
      : '';
    this.pausedTranscript = this.current.transcript ?? '';
    this.generation += 1;
    this.activeOperation?.abort();
    this.activeOperation = null;
    this.clearThinkingTimer();
    await Promise.allSettled([
      this.dependencies.stopCapture(),
      this.dependencies.cancelSpeech(),
    ]);
    this.turnActive = false;
    this.emit('paused', 'tool-approval', { approvalId });
  }

  async resumeAfterApproval(pendingApprovals: number): Promise<void> {
    if (
      this.current.state !== 'paused'
      || this.current.reason !== 'tool-approval'
    ) {
      throw new Error('Voice is not paused for approval.');
    }
    if (pendingApprovals > 0) throw new Error('A tool approval is still pending.');
    if (this.pausedRunId) {
      const runId = this.pausedRunId;
      const transcript = this.pausedTranscript;
      this.pausedRunId = '';
      this.pausedTranscript = '';
      this.turnActive = true;
      this.emit('thinking', 'approval-resolved', { runId, transcript });
      this.armThinkingTimeout(runId);
      const deferred = this.deferredAssistant;
      this.deferredAssistant = undefined;
      if (deferred) await this.assistantFinal(deferred);
      return;
    }
    await this.restartOrIdle('approval-resolved');
  }

  async pause(reason: 'manual' | 'background' | 'input-disabled' | 'device-disconnected'): Promise<void> {
    this.generation += 1;
    this.activeOperation?.abort();
    this.activeOperation = null;
    this.clearThinkingTimer();
    await Promise.allSettled([
      this.dependencies.stopCapture(),
      this.dependencies.cancelSpeech(),
    ]);
    this.turnActive = false;
    this.emit('paused', reason);
  }

  async cancel(reason = 'manual'): Promise<void> {
    this.generation += 1;
    this.activeOperation?.abort();
    this.activeOperation = null;
    this.clearThinkingTimer();
    await Promise.allSettled([
      this.dependencies.stopCapture(),
      this.dependencies.cancelSpeech(),
    ]);
    this.turnActive = false;
    this.pendingTranscript = '';
    this.emit('cancelled', reason);
  }

  async recover(): Promise<void> {
    if (!['error', 'offline', 'auth', 'model-unavailable', 'cancelled'].includes(
      this.current.state,
    )) {
      throw new Error('Voice conversation does not require recovery.');
    }
    await this.restartOrIdle('recovered');
  }

  private async dispatchTranscript(
    transcript: string,
    generation: number,
  ): Promise<void> {
    this.emit('sending', undefined, { transcript });
    const controller = new AbortController();
    this.activeOperation = controller;
    try {
      const sent = await this.withTimeout(
        this.dependencies.sendTranscript(transcript, controller.signal),
        this.settings.operationTimeoutMs,
        'send-timeout',
        () => controller.abort(),
      );
      if (generation !== this.generation) return;
      this.emit('thinking', undefined, {
        transcript,
        runId: sent.runId,
      });
      this.ownedRunIds.add(sent.runId);
      this.armThinkingTimeout(sent.runId);
    } catch (error) {
      if (generation !== this.generation) return;
      this.turnActive = false;
      this.emit(failureState(error), (error as Error).message || 'send-failed');
    } finally {
      if (this.activeOperation === controller) this.activeOperation = null;
    }
  }

  private async restartOrIdle(reason: string): Promise<void> {
    if (this.settings.inputEnabled && this.settings.continuousConversation) {
      this.emit('listening', reason);
    } else {
      this.emit('idle', reason);
    }
  }

  private emit(
    state: VoiceConversationState,
    reason?: string,
    values: Partial<VoiceConversationSnapshot> = {},
  ): void {
    this.current = Object.freeze({
      state,
      turn: state === 'listening' && this.current.state !== 'listening'
        ? this.current.turn + 1
        : this.current.turn,
      reason,
      ...values,
    });
    this.dependencies.onState(this.current);
  }

  private clearThinkingTimer(): void {
    if (this.thinkingTimer !== undefined) {
      this.clock.clearTimeout(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  private armThinkingTimeout(runId: string): void {
    this.clearThinkingTimer();
    this.thinkingTimer = this.clock.setTimeout(() => {
      if (
        this.current.state === 'thinking'
        && this.current.runId === runId
      ) {
        this.turnActive = false;
        this.emit('error', 'response-timeout');
      }
    }, this.settings.thinkingTimeoutMs);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    reason: string,
    onTimeout?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(
        () => {
          onTimeout?.();
          reject(new Error(reason));
        },
        timeoutMs,
      );
      promise.then(
        (value) => {
          this.clock.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          this.clock.clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
