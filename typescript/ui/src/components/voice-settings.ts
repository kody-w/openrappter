import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { desktopBridge } from '../services/desktop.js';

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
    if (event.key === 'Escape') this.close();
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
    this.emitStatus();
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

  private providerChanged = async (event: Event) => {
    const provider = (event.target as HTMLSelectElement).value as ProviderId;
    await this.run(async () => desktopBridge()!.voice({
      action: 'provider.set',
      provider,
      voice: this.status.selectedVoice,
      model: this.status.selectedModel,
    }));
  };

  private catalogSelectionChanged = async (
    field: 'voice' | 'model',
    event: Event,
  ) => {
    const value = (event.target as HTMLSelectElement).value;
    await this.run(async () => desktopBridge()!.voice({
      action: 'provider.set',
      provider: 'elevenlabs',
      voice: field === 'voice' ? value : this.status.selectedVoice,
      model: field === 'model' ? value : this.status.selectedModel,
    }));
  };

  private preview = async (smoke: boolean) => {
    const result = await this.run(async () => desktopBridge()!.voice({
      action: smoke ? 'smoke' : 'preview',
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
    const selected = this.status.provider ?? 'local';
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
        @keydown=${(event: KeyboardEvent) => event.key === 'Escape' && this.close()}
      >
        <header>
          <h2 id="voice-settings-title">Voice settings</h2>
          <button @click=${this.close} aria-label="Close voice settings">✕</button>
        </header>

        <label>
          Provider
          <select
            .value=${selected}
            @change=${this.providerChanged}
            ?disabled=${this.busy}
          >
            ${providers.map((provider) => html`
              <option value=${provider.id}>${provider.name}</option>
            `)}
          </select>
        </label>

        <strong>ElevenLabs setup</strong>
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

        ${selected === 'elevenlabs' && eleven?.verified
          ? html`
              <label>
                Verified voice
                <select
                  .value=${this.status.selectedVoice ?? voices[0]?.id ?? ''}
                  @change=${(event: Event) => this.catalogSelectionChanged('voice', event)}
                >
                  ${voices.map((voice) => html`
                    <option value=${voice.id}>${voice.name} (${voice.language})</option>
                  `)}
                </select>
              </label>
              <label>
                Verified model
                <select
                  .value=${this.status.selectedModel ?? models[0]?.id ?? ''}
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

        <div class="estimate">${estimate}</div>
        <div class="disclosure">
          ${this.status.disclosure ??
          'ElevenLabs receives only the exact final assistant text selected for speech—never user prompts or conversation history.'}
        </div>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
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
