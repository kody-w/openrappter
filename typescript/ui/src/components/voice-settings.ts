import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { desktopBridge } from '../services/desktop.js';
import {
  ALLOWED_PUSH_TO_TALK_KEYS,
  DEFAULT_GRAIL_VOICE_SETTINGS,
  DefaultGrailVoiceIntegrationAdapter,
  type GrailVoiceSettings,
} from '../../../src/voice/grail-adapter.js';

type ProviderId = 'system' | 'local' | 'elevenlabs';

interface VoiceStatus {
  enabled?: boolean;
  provider?: ProviderId;
  selectedVoice?: string;
  selectedModel?: string;
  providers?: Array<{
    id: ProviderId;
    name: string;
    available: boolean;
    configured: boolean;
    verified?: boolean;
    verifiedAt?: string;
    masked?: string;
  }>;
  catalog?: {
    voices: Array<{ id: string; name: string; language: string }>;
    models: Array<{ id: string; name: string; languages: string[] }>;
  };
  quota?: { usedCharacters: number | null; limitCharacters: number | null };
  settings?: Partial<GrailVoiceSettings>;
  inputDevices?: Array<{ id: string; label: string }>;
  disclosure?: string;
}

function audioBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

@customElement('openrappter-voice-settings')
export class OpenRappterVoiceSettings extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      z-index: 30;
      top: 48px;
      right: 0.75rem;
      width: min(390px, calc(100vw - 1.5rem));
    }
    .panel {
      color: var(--text-primary);
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      box-shadow: 0 12px 40px rgba(0,0,0,.35);
      padding: 1rem;
      display: grid;
      gap: .75rem;
    }
    header { display:flex; align-items:center; justify-content:space-between; }
    h2 { font-size: 1rem; margin: 0; }
    label { display:grid; gap:.3rem; font-size:.78rem; color:var(--text-secondary); }
    select, input {
      padding:.5rem;
      color:var(--text-primary);
      background:var(--bg-tertiary);
      border:1px solid var(--border);
      border-radius:.375rem;
      font:inherit;
    }
    button {
      padding:.45rem .65rem;
      color:var(--text-primary);
      background:var(--bg-tertiary);
      border:1px solid var(--border);
      border-radius:.375rem;
      cursor:pointer;
    }
    button.primary { color:var(--accent-foreground); background:var(--accent); }
    button.danger { color:var(--error); }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline:2px solid var(--accent); outline-offset:2px;
    }
    .row { display:flex; gap:.5rem; flex-wrap:wrap; }
    .group {
      display:grid; gap:.65rem; padding:.75rem;
      border:1px solid var(--border); border-radius:.5rem;
    }
    .toggle { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
    .toggle input { width:auto; }
    .credential { border-top:2px solid var(--border); padding-top:.75rem; display:grid; gap:.65rem; }
    .listening-dot {
      width:.65rem; height:.65rem; display:inline-block; border-radius:50%;
      background:#ef4444; margin-right:.35rem;
    }
    .status, .disclosure, .estimate {
      font-size:.75rem; line-height:1.45; color:var(--text-secondary);
    }
    .verified { color:#22c55e; }
    .error { color:var(--error); }
    .busy { opacity:.7; }
  `;

  @state() private status: VoiceStatus = {};
  @state() private apiKey = '';
  @state() private busy = false;
  @state() private error = '';
  @state() private result = '';
  @state() private draft: GrailVoiceSettings = DEFAULT_GRAIL_VOICE_SETTINGS;
  @state() private inputDevices: Array<{ id: string; label: string }> = [];
  private adapter = new DefaultGrailVoiceIntegrationAdapter();
  private committed: GrailVoiceSettings = DEFAULT_GRAIL_VOICE_SETTINGS;
  private activeAudio?: HTMLAudioElement;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    window.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKeydown);
    this.activeAudio?.pause();
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      this.cancelSettings();
      this.close();
    }
  };

  private close(): void {
    this.dispatchEvent(new CustomEvent('voice-settings-close', {
      bubbles: true,
      composed: true,
    }));
  }

  private async refresh(): Promise<void> {
    const desktop = desktopBridge();
    if (!desktop) return;
    this.status = await desktop.voice({ action: 'status' }) as VoiceStatus;
    this.inputDevices = this.status.inputDevices ?? await this.enumerateInputs();
    this.adapter = new DefaultGrailVoiceIntegrationAdapter({
      ...DEFAULT_GRAIL_VOICE_SETTINGS,
      ...this.status.settings,
      provider: this.status.settings?.provider ?? this.status.provider ?? 'local',
      ttsVoice: this.status.settings?.ttsVoice ?? this.status.selectedVoice,
      ttsModel: this.status.settings?.ttsModel ?? this.status.selectedModel,
      outputEnabled: this.status.settings?.outputEnabled ?? this.status.enabled ?? false,
      autoSpeak: this.status.settings?.autoSpeak ?? false,
    });
    this.committed = this.adapter.settings;
    this.draft = { ...this.committed };
    this.emitStatus();
  }

  private async enumerateInputs(): Promise<Array<{ id: string; label: string }>> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      return (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          id: device.deviceId || 'default',
          label: device.label || `Microphone ${index + 1}`,
        }));
    } catch {
      return [];
    }
  }

  private emitStatus(): void {
    this.dispatchEvent(new CustomEvent('voice-status-change', {
      detail: this.status,
      bubbles: true,
      composed: true,
    }));
  }

  private async run(action: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
    this.busy = true;
    this.error = '';
    this.result = '';
    try {
      const result = await action();
      if (Array.isArray(result.providers)) {
        this.status = result as VoiceStatus;
      } else {
        await this.refresh();
      }
      this.emitStatus();
      return result;
    } catch (error) {
      this.error = (error as Error).message;
      await this.refresh().catch(() => {});
      return null;
    } finally {
      this.busy = false;
    }
  }

  private saveKey = async () => {
    let key = this.apiKey;
    this.apiKey = '';
    const request = desktopBridge()!.voice({
      action: 'credential.set',
      apiKey: key,
    });
    key = '';
    const result = await this.run(async () => request);
    if (result) this.result = 'Credential verified and stored in OS-protected storage.';
  };

  private testSubmittedKey = async () => {
    let key = this.apiKey;
    this.apiKey = '';
    const request = desktopBridge()!.voice({
      action: 'credential.test',
      apiKey: key,
    });
    key = '';
    const result = await this.run(async () => request);
    if (result) this.result = 'Credential verified. It was not stored.';
  };

  private testStoredKey = async () => {
    const result = await this.run(async () => desktopBridge()!.voice({
      action: 'credential.testStored',
    }));
    if (result) this.result = 'Stored credential verified.';
  };

  private deleteKey = async () => {
    const result = await this.run(async () => desktopBridge()!.voice({
      action: 'credential.delete',
    }));
    if (result) this.result = 'ElevenLabs credential deleted.';
  };

  private providerChanged = (event: Event) => {
    const provider = (event.target as HTMLSelectElement).value as ProviderId;
    this.draft = {
      ...this.draft,
      provider,
      ttsVoice: this.draft.ttsVoice ?? this.status.catalog?.voices[0]?.id,
      ttsModel: this.draft.ttsModel ?? this.status.catalog?.models[0]?.id,
    };
  };

  private catalogSelectionChanged = async (
    field: 'voice' | 'model',
    event: Event,
  ) => {
    const value = (event.target as HTMLSelectElement).value;
    this.draft = {
      ...this.draft,
      [field === 'voice' ? 'ttsVoice' : 'ttsModel']: value,
    };
  };

  private updateBoolean(
    field: 'outputEnabled' | 'autoSpeak' | 'inputEnabled' | 'continuousConversation',
    event: Event,
  ): void {
    this.draft = {
      ...this.draft,
      [field]: (event.target as HTMLInputElement).checked,
    };
  }

  private updateSelect(
    field: 'pushToTalkKey' | 'inputDeviceId' | 'transcriptPolicy' | 'wakeLock',
    event: Event,
  ): void {
    this.draft = {
      ...this.draft,
      [field]: (event.target as HTMLSelectElement).value,
    };
  }

  private saveSettings = async () => {
    let reviewed: GrailVoiceSettings;
    try {
      reviewed = this.adapter.reviewAndCommit(this.draft, {
        reservedKeys: ['Escape', 'Enter'],
        availableInputDeviceIds: this.inputDevices.length > 0
          ? this.inputDevices.map((device) => device.id)
          : undefined,
      });
    } catch (error) {
      this.error = (error as Error).message;
      return;
    }
    const result = await this.run(async () => desktopBridge()!.voice({
      action: 'settings.save',
      settings: reviewed,
    }));
    if (result) {
      this.committed = this.adapter.settings;
      this.draft = { ...reviewed };
      this.result = 'Reviewed voice settings saved.';
    }
  };

  private cancelSettings = () => {
    this.draft = { ...this.adapter.discardDraft() };
    this.error = '';
    this.result = 'Unsaved voice settings discarded.';
  };

  private preview = async (smoke: boolean) => {
    const result = await this.run(async () => desktopBridge()!.voice({
      action: smoke ? 'smoke' : 'preview',
      voice: this.draft.ttsVoice,
      model: this.draft.ttsModel,
    }));
    if (!result) return;
    const bytes = audioBytes(result.audio);
    const mimeType = typeof result.mimeType === 'string' ? result.mimeType : '';
    if (!bytes || !mimeType.startsWith('audio/')) {
      this.error = 'Voice preview returned invalid audio.';
      return;
    }
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: mimeType }));
    this.activeAudio?.pause();
    const audio = new Audio(url);
    this.activeAudio = audio;
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
    this.result = smoke
      ? `Safe smoke: ElevenLabs · ${String(result.voice)} · ${String(result.durationSeconds)}s · sha256 ${String(result.sha256).slice(0, 12)}…`
      : `Preview: ${String(result.characters)} characters · about ${String(result.durationSeconds)}s · estimated $${String(result.estimatedCostUsd ?? '0.0000')}`;
  };

  private cancelSpeech = async () => {
    this.activeAudio?.pause();
    this.activeAudio = undefined;
    await desktopBridge()!.voice({ action: 'cancel' });
    this.result = 'Speech cancelled.';
  };

  render() {
    const providers = this.status.providers ?? [];
    const eleven = providers.find((provider) => provider.id === 'elevenlabs');
    const selected = this.draft.provider;
    const voices = this.status.catalog?.voices ?? [];
    const models = this.status.catalog?.models ?? [];
    const estimate = selected === 'elevenlabs'
      ? 'Speech is metered by characters. Estimate: $0.30 / 1,000 characters; actual plan pricing may differ. Preview: 40 characters; live smoke: 23 characters.'
      : 'System and local voice do not use ElevenLabs character quota.';

    return html`
      <section
        class="panel ${this.busy ? 'busy' : ''}"
        role="dialog"
        aria-modal="false"
        aria-labelledby="voice-settings-title"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            this.cancelSettings();
            this.close();
          }
        }}
      >
        <header>
          <h2 id="voice-settings-title">Voice settings</h2>
          <button @click=${() => {
            this.cancelSettings();
            this.close();
          }} aria-label="Close voice settings">✕</button>
        </header>

        <div class="group">
          <strong>Voice output</strong>
          <label class="toggle">
            <span>Enable voice output</span>
            <input type="checkbox"
              .checked=${this.draft.outputEnabled}
              @change=${(event: Event) => this.updateBoolean('outputEnabled', event)} />
          </label>
          <label class="toggle">
            <span>Auto-speak responses</span>
            <input type="checkbox"
              .checked=${this.draft.autoSpeak}
              @change=${(event: Event) => this.updateBoolean('autoSpeak', event)} />
          </label>
          <label>
            Provider
            <select .value=${selected} @change=${this.providerChanged} ?disabled=${this.busy}>
              ${providers.map((provider) => html`
                <option value=${provider.id}>${provider.name}</option>
              `)}
            </select>
          </label>

          ${selected === 'elevenlabs' && eleven?.verified
            ? html`
                <label>
                  Verified TTS voice
                  <select
                    .value=${this.draft.ttsVoice ?? voices[0]?.id ?? ''}
                    @change=${(event: Event) => this.catalogSelectionChanged('voice', event)}
                  >
                    ${voices.map((voice) => html`
                      <option value=${voice.id}>${voice.name} (${voice.language})</option>
                    `)}
                  </select>
                </label>
                <label>
                  Verified TTS model
                  <select
                    .value=${this.draft.ttsModel ?? models[0]?.id ?? ''}
                    @change=${(event: Event) => this.catalogSelectionChanged('model', event)}
                  >
                    ${models.map((model) => html`
                      <option value=${model.id}>${model.name}</option>
                    `)}
                  </select>
                </label>
                <div class="row">
                  <button @click=${() => this.preview(false)} ?disabled=${this.busy}>Preview</button>
                  <button @click=${() => this.preview(true)} ?disabled=${this.busy}>Safe live smoke</button>
                  <button @click=${this.cancelSpeech}>Cancel speech</button>
                </div>
              `
            : nothing}
        </div>

        <div class="group">
          <strong>Voice input</strong>
          <label class="toggle">
            <span>Enable voice input</span>
            <input type="checkbox"
              .checked=${this.draft.inputEnabled}
              @change=${(event: Event) => this.updateBoolean('inputEnabled', event)} />
          </label>
          <label class="toggle">
            <span>Continuous conversation mode</span>
            <input type="checkbox"
              .checked=${this.draft.continuousConversation}
              @change=${(event: Event) => this.updateBoolean('continuousConversation', event)} />
          </label>
          <label>
            Push-to-talk key
            <select .value=${this.draft.pushToTalkKey}
              @change=${(event: Event) => this.updateSelect('pushToTalkKey', event)}>
              ${ALLOWED_PUSH_TO_TALK_KEYS.map((key) => html`
                <option value=${key}>${key.replace(/Right$/, ' (right)')}</option>
              `)}
            </select>
          </label>
          <label>
            Input device
            <select .value=${this.draft.inputDeviceId}
              @change=${(event: Event) => this.updateSelect('inputDeviceId', event)}>
              <option value="default">Default microphone</option>
              ${this.inputDevices
                .filter((device) => device.id !== 'default')
                .map((device) => html`<option value=${device.id}>${device.label}</option>`)}
            </select>
          </label>
          <label class="toggle">
            <span>Review transcript before sending</span>
            <input type="checkbox"
              .checked=${this.draft.transcriptPolicy === 'review'}
              @change=${(event: Event) => {
                this.draft = {
                  ...this.draft,
                  transcriptPolicy: (event.target as HTMLInputElement).checked
                    ? 'review'
                    : 'auto',
                };
              }} />
          </label>
          <label>
            Wake-lock policy
            <select .value=${this.draft.wakeLock}
              @change=${(event: Event) => this.updateSelect('wakeLock', event)}>
              <option value="never">Never</option>
              <option value="while-listening">While listening only</option>
            </select>
          </label>
          <div class="status">
            <span class="listening-dot"></span>
            The red indicator is visible whenever the microphone is listening.
            Capture pauses when the app is hidden or minimized.
          </div>
        </div>

        <div class="row">
          <button class="primary" @click=${this.saveSettings} ?disabled=${this.busy}>
            Save settings
          </button>
          <button @click=${this.cancelSettings} ?disabled=${this.busy}>Cancel</button>
        </div>

        <div class="credential">
          <strong>Secure ElevenLabs credential setup</strong>
              <div class="status ${eleven?.verified ? 'verified' : ''}">
                ${eleven?.verified
                  ? `✓ Verified ${eleven.masked ?? ''} · ${eleven.verifiedAt ?? ''}`
                  : 'Not verified — ElevenLabs is not ready.'}
              </div>
              <label>
                ElevenLabs API key
                <input
                  type="password"
                  autocomplete="off"
                  spellcheck="false"
                  maxlength="256"
                  .value=${this.apiKey}
                  @input=${(event: Event) => {
                    this.apiKey = (event.target as HTMLInputElement).value;
                  }}
                  aria-describedby="voice-key-help"
                />
              </label>
              <div id="voice-key-help" class="status">
                Submitted directly to the desktop main process, encrypted with the OS credential
                service, and never returned to this renderer.
              </div>
              <div class="row">
                <button class="primary" @click=${this.saveKey} ?disabled=${this.busy || this.apiKey.length < 20}>
                  Verify & save
                </button>
                <button @click=${this.testSubmittedKey} ?disabled=${this.busy || this.apiKey.length < 20}>
                  Test without saving
                </button>
                ${eleven?.configured
                  ? html`
                      <button @click=${this.testStoredKey} ?disabled=${this.busy}>Test stored</button>
                      <button class="danger" @click=${this.deleteKey} ?disabled=${this.busy}>Delete key</button>
                    `
                  : nothing}
              </div>
        </div>

        <div class="estimate">${estimate}</div>
        <div class="disclosure">
          ${this.status.disclosure ??
          'ElevenLabs receives only the exact final assistant text selected for speech—never user prompts or conversation history.'}
        </div>
        <div aria-live="assertive" aria-atomic="true">
          ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        </div>
        ${this.result ? html`<div class="status" role="status">${this.result}</div>` : nothing}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-voice-settings': OpenRappterVoiceSettings;
  }
}
