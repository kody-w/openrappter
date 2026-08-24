import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  GrailVoiceConversation,
  type VoiceAssistantOutput,
  type VoiceConversationSnapshot,
} from '../../../src/voice/conversation.js';
import {
  DEFAULT_GRAIL_VOICE_SETTINGS,
  reviewGrailVoiceSettings,
  type GrailVoiceSettings,
} from '../../../src/voice/grail-adapter.js';
import {
  BrowserVoiceCaptureBackend,
  GrailVoiceInputCapture,
} from '../services/voice-input.js';
import { desktopBridge } from '../services/desktop.js';
import { gateway } from '../services/gateway.js';

interface VoiceStatusPayload {
  settings?: Partial<GrailVoiceSettings>;
  enabled?: boolean;
  autoSpeak?: boolean;
  provider?: 'system' | 'local' | 'elevenlabs';
  selectedVoice?: string;
  selectedModel?: string;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

@customElement('openrappter-voice-conversation')
export class OpenRappterVoiceConversation extends LitElement {
  static styles = css`
    :host { display:block; }
    .bar {
      display:flex; align-items:center; gap:.5rem; flex-wrap:wrap;
      padding:.45rem 1rem; border-bottom:1px solid var(--border);
      background:var(--bg-secondary); font-size:.78rem;
    }
    .indicator {
      width:.7rem; height:.7rem; border-radius:50%; background:#64748b;
      box-shadow:0 0 0 2px rgba(100,116,139,.2);
    }
    .indicator.listening {
      background:#ef4444; box-shadow:0 0 0 3px rgba(239,68,68,.25);
      animation:pulse 1.2s infinite;
    }
    .indicator.speaking { background:#22c55e; }
    .indicator.error { background:#f59e0b; }
    @keyframes pulse { 50% { opacity:.45; } }
    button {
      color:var(--text-primary); background:var(--bg-tertiary);
      border:1px solid var(--border); border-radius:.35rem;
      padding:.3rem .55rem; cursor:pointer; font:inherit;
    }
    button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .transcript { flex:1; min-width:180px; color:var(--text-secondary); }
    .privacy { color:var(--text-secondary); opacity:.85; }
    .error { color:var(--error); }
  `;

  @property({ attribute: false })
  sendTranscript?: (
    transcript: string,
    signal: AbortSignal,
  ) => Promise<{ runId: string }>;

  @property({ attribute: false })
  speakAssistant?: (
    output: VoiceAssistantOutput,
    signal: AbortSignal,
  ) => Promise<void>;

  @state() private snapshot: VoiceConversationSnapshot = {
    state: 'idle',
    turn: 0,
  };
  @state() private transcript = '';
  @state() private error = '';
  @state() private settings: GrailVoiceSettings =
    DEFAULT_GRAIL_VOICE_SETTINGS;

  private readonly capture: GrailVoiceInputCapture = new GrailVoiceInputCapture(
    new BrowserVoiceCaptureBackend(),
    {
      onEndpoint: async (audio): Promise<void> => {
        await this.conversation.submitEndpoint(audio);
      },
      onError: (code) => this.handleCaptureError(code),
      onListeningChanged: () => this.requestUpdate(),
    },
  );
  private readonly conversation: GrailVoiceConversation =
    new GrailVoiceConversation(
    this.settings,
    {
      transcribeLocal: async (audio, signal) => this.transcribeLocal(audio, signal),
      showTranscript: (text) => {
        this.transcript = text;
      },
      sendTranscript: async (text, signal) => {
        if (!this.sendTranscript) throw new Error('Chat send path is unavailable.');
        return this.sendTranscript(text, signal);
      },
      speakAssistant: async (output, signal) => {
        if (!this.speakAssistant) throw new Error('Speech output path is unavailable.');
        return this.speakAssistant(output, signal);
      },
      cancelSpeech: async () => {
        await desktopBridge()?.voice({ action: 'cancel' }).catch(() => {});
      },
      stopCapture: async (): Promise<void> => {
        await this.capture.stop();
      },
      onState: (snapshot) => this.onConversationState(snapshot),
    },
  );
  private wakeLock?: WakeLockSentinelLike;

  connectedCallback(): void {
    super.connectedCallback();
    void desktopBridge()?.voice({ action: 'status' }).then((status) => {
      this.applyStatus(status as VoiceStatusPayload);
    }).catch(() => {});
    gateway.on('approval', this.onApproval);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    gateway.off('approval', this.onApproval);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    this.capture.dispose();
    void this.releaseWakeLock();
  }

  applyStatus(status: VoiceStatusPayload): void {
    try {
      this.settings = reviewGrailVoiceSettings({
        ...DEFAULT_GRAIL_VOICE_SETTINGS,
        ...status.settings,
        outputEnabled: status.settings?.outputEnabled ?? status.enabled ?? false,
        autoSpeak: status.settings?.autoSpeak ?? status.autoSpeak ?? false,
        provider: status.settings?.provider ?? status.provider ?? 'local',
        ttsVoice: status.settings?.ttsVoice ?? status.selectedVoice,
        ttsModel: status.settings?.ttsModel ?? status.selectedModel,
      });
      this.conversation.updateSettings(this.settings);
      if (!this.settings.inputEnabled && this.capture.active) {
        void this.conversation.pause('input-disabled');
      }
    } catch (error) {
      this.error = (error as Error).message;
    }
  }

  async assistantFinal(output: VoiceAssistantOutput): Promise<boolean> {
    return this.conversation.assistantFinal(output);
  }

  noteSpokenText(text: string): void {
    this.conversation.noteSpokenText(text);
  }

  async cancelConversation(reason = 'session-change'): Promise<void> {
    await this.conversation.cancel(reason);
  }

  get hasActiveConversation(): boolean {
    return !['idle', 'cancelled'].includes(this.snapshot.state);
  }

  assistantFailed(runId: string, code: string): boolean {
    return this.conversation.assistantFailed(runId, code);
  }

  private onConversationState(snapshot: VoiceConversationSnapshot): void {
    this.snapshot = snapshot;
    this.error = ['error', 'offline', 'auth', 'model-unavailable'].includes(
      snapshot.state,
    ) ? snapshot.reason ?? snapshot.state : '';
    if (snapshot.state === 'listening') {
      void this.acquireWakeLock();
      if (!this.capture.active) {
        const mode = snapshot.reason === 'push-to-talk'
          ? 'push-to-talk'
          : this.settings.continuousConversation
            ? 'continuous'
            : 'manual';
        void this.capture.start(this.settings, mode).catch((error: unknown) => {
          this.error = (error as Error).message;
          this.conversation.fail(
            /permission/i.test(this.error) ? 'mic-permission-denied' : 'microphone',
          );
        });
      }
    } else {
      void this.releaseWakeLock();
    }
  }

  private async transcribeLocal(
    audio: Uint8Array,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const desktop = desktopBridge();
    if (!desktop) throw new Error('Local Whisper requires OpenRappter Desktop.');
    const status = await desktop.narration({ action: 'status' });
    if (String(status.model ?? 'missing') !== 'ready') {
      await desktop.narration({ action: 'download' });
    }
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const durationMs = audio.byteLength / 4 / 16_000 * 1_000;
    const result = await desktop.narration({
      action: 'voice.transcribe',
      duration_ms: durationMs,
      samples: audio,
    });
    return String(result.text ?? '');
  }

  private handleCaptureError(code: string): void {
    if (code === 'device-disconnected') {
      void this.conversation.pause('device-disconnected');
      return;
    }
    if (code === 'no-speech-timeout') {
      void this.conversation.pause('manual');
      this.error = 'No speech detected before the listening timeout.';
      return;
    }
    this.conversation.fail(code);
  }

  private startManual = async () => {
    this.error = '';
    await this.conversation.beginListening(
      this.snapshot.state === 'speaking' ? 'barge-in' : 'manual',
    );
  };

  private startPointerPushToTalk = async (event: PointerEvent) => {
    event.preventDefault();
    await this.conversation.pushToTalkPressed(this.settings.pushToTalkKey);
  };

  private stopAll = async () => {
    await this.conversation.cancel('manual');
  };

  private confirmTranscript = async () => {
    await this.conversation.confirmTranscript();
  };

  private resumeAfterApproval = async () => {
    const pending = await gateway.call<Array<unknown>>('exec.pending');
    await this.conversation.resumeAfterApproval(pending.length);
  };

  private recover = async () => {
    await this.conversation.recover();
  };

  private onApproval = (payload: unknown) => {
    const approval = payload as { id?: string };
    void this.conversation.approvalRequested(approval.id ?? 'pending');
  };

  private onVisibilityChange = () => {
    if (document.hidden && this.settings.backgroundBehavior === 'pause') {
      void this.conversation.pause('background');
    }
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (
      !this.settings.inputEnabled
      || this.settings.continuousConversation
      || event.repeat
      || event.code !== this.settings.pushToTalkKey
      || this.isEditable(event.target)
      || (
        (event.metaKey || event.ctrlKey || event.altKey)
        && event.code !== 'ControlRight'
        && event.code !== 'AltRight'
      )
    ) {
      return;
    }
    event.preventDefault();
    void this.conversation.pushToTalkPressed(this.settings.pushToTalkKey);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (
      event.code !== this.settings.pushToTalkKey
      || !this.capture.active
      || this.isEditable(event.target)
    ) {
      return;
    }
    event.preventDefault();
    void this.capture.releasePushToTalk();
  };

  private isEditable(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return !!element?.closest?.(
      'input, textarea, select, button, a, [contenteditable="true"]',
    );
  }

  private async acquireWakeLock(): Promise<void> {
    if (this.settings.wakeLock !== 'while-listening' || this.wakeLock) return;
    const manager = (
      navigator as Navigator & {
        wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    if (!manager || document.hidden) return;
    try {
      this.wakeLock = await manager.request('screen');
    } catch {
      // Wake lock is advisory; capture remains bounded without it.
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const lock = this.wakeLock;
    this.wakeLock = undefined;
    await lock?.release().catch(() => {});
  }

  render() {
    if (!desktopBridge() || (!this.settings.inputEnabled && this.snapshot.state === 'idle')) {
      return nothing;
    }
    const listening = this.snapshot.state === 'listening';
    const speaking = this.snapshot.state === 'speaking';
    const failed = ['error', 'offline', 'auth', 'model-unavailable'].includes(
      this.snapshot.state,
    );
    return html`
      <div class="bar" aria-label="Voice conversation controls">
        <span
          class="indicator ${listening ? 'listening' : speaking ? 'speaking' : failed ? 'error' : ''}"
          aria-hidden="true"
        ></span>
        <strong role="status" aria-live="polite">
          ${listening ? 'Listening' : this.snapshot.state}
        </strong>
        <span class="transcript">
          ${this.transcript
            ? `Transcript: ${this.transcript}`
            : 'Microphone audio stays local and is not retained.'}
        </span>
        ${this.snapshot.reason === 'transcript-review'
          ? html`
              <button @click=${this.confirmTranscript}>Send transcript</button>
              <button @click=${this.stopAll}>Discard</button>
            `
          : nothing}
        ${this.snapshot.reason === 'tool-approval'
          ? html`
              <span class="privacy">Human tool approval required.</span>
              <button @click=${this.resumeAfterApproval}>Resume after approval</button>
            `
          : nothing}
        ${failed
          ? html`<button @click=${this.recover}>Retry voice</button>`
          : nothing}
        ${this.snapshot.state === 'paused'
          && this.snapshot.reason !== 'transcript-review'
          && this.snapshot.reason !== 'tool-approval'
          && this.settings.inputEnabled
          ? html`<button @click=${this.startManual}>Resume listening</button>`
          : nothing}
        ${!listening && this.snapshot.state !== 'paused'
          ? html`<button
              @click=${this.settings.continuousConversation ? this.startManual : nothing}
              @pointerdown=${this.settings.continuousConversation
                ? nothing
                : this.startPointerPushToTalk}
              @pointerup=${this.settings.continuousConversation
                ? nothing
                : () => this.capture.releasePushToTalk()}
              aria-label=${speaking ? 'Interrupt and listen' : 'Start listening'}
            >${speaking ? 'Barge in' : 'Listen'}</button>`
          : nothing}
        <button @click=${this.stopAll}>Mute / stop</button>
        <span class="error" aria-live="assertive">${this.error}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-voice-conversation': OpenRappterVoiceConversation;
  }
}
