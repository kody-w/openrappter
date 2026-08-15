import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import {
  desktopBridge,
  type DesktopShowAndTellRequest,
} from '../services/desktop.js';

interface SessionSummary {
  id: string;
  state: string;
  title: string;
  intentHint: string;
  startedAt: number;
}

interface AnalysisStep {
  id: string;
  title: string;
  detail: string;
  tool?: string;
  confidence?: string;
}

interface Analysis {
  title: string;
  intent: string;
  approved: boolean;
  steps: AnalysisStep[];
}

@customElement('openrappter-show-and-tell')
export class OpenRappterShowAndTell extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--text-primary);
      background:
        radial-gradient(circle at 16% 8%, rgba(88, 245, 210, 0.09), transparent 24rem),
        var(--bg-primary);
    }

    .shell {
      max-width: 1180px;
      margin: 0 auto;
      padding: 2rem;
    }

    .hero {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1.5rem;
      margin-bottom: 1.5rem;
    }

    h2, h3, p {
      margin: 0;
    }

    h2 {
      font-size: clamp(1.8rem, 3vw, 2.8rem);
      letter-spacing: -0.04em;
    }

    .lede {
      max-width: 760px;
      margin-top: 0.7rem;
      color: var(--text-secondary);
      line-height: 1.65;
    }

    .privacy {
      min-width: 210px;
      border: 1px solid rgba(88, 245, 210, 0.22);
      border-radius: 0.8rem;
      padding: 0.8rem 1rem;
      background: rgba(88, 245, 210, 0.07);
      color: #bdfcef;
      font-size: 0.78rem;
      line-height: 1.45;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(260px, 0.7fr);
      gap: 1rem;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 0.9rem;
      background: var(--bg-secondary);
      padding: 1rem;
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.12);
    }

    .card + .card {
      margin-top: 1rem;
    }

    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 0.9rem;
    }

    .eyebrow {
      color: var(--accent);
      font: 600 0.7rem/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      border-radius: 999px;
      padding: 0.35rem 0.65rem;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 0.72rem;
      text-transform: capitalize;
    }

    .state.recording {
      background: rgba(248, 113, 113, 0.13);
      color: #fda4af;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }

    label {
      display: grid;
      gap: 0.4rem;
      color: var(--text-secondary);
      font-size: 0.76rem;
    }

    input, textarea, select {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border);
      border-radius: 0.55rem;
      padding: 0.65rem 0.75rem;
      background: var(--bg-primary);
      color: var(--text-primary);
      font: inherit;
    }

    textarea {
      min-height: 86px;
      resize: vertical;
    }

    .fields {
      display: grid;
      gap: 0.75rem;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.65rem;
      align-items: end;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-top: 0.9rem;
    }

    button {
      border: 1px solid var(--border);
      border-radius: 0.55rem;
      padding: 0.6rem 0.85rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font: 600 0.78rem/1 inherit;
    }

    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: white;
    }

    button.danger {
      border-color: rgba(248, 113, 113, 0.35);
      color: #fda4af;
    }

    button:disabled {
      opacity: 0.5;
      cursor: wait;
    }

    .steps {
      display: grid;
      gap: 0.65rem;
      margin-top: 0.9rem;
    }

    .step {
      display: grid;
      grid-template-columns: 2rem 1fr;
      gap: 0.65rem;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      background: var(--bg-primary);
    }

    .step-number {
      display: grid;
      place-items: center;
      width: 1.8rem;
      height: 1.8rem;
      border-radius: 50%;
      background: rgba(88, 245, 210, 0.1);
      color: var(--accent);
      font-size: 0.75rem;
      font-weight: 700;
    }

    .step p {
      margin-top: 0.25rem;
      color: var(--text-secondary);
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .tool {
      display: inline-block;
      margin-top: 0.35rem;
      color: var(--accent);
      font: 0.68rem ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .session {
      display: block;
      width: 100%;
      margin-top: 0.5rem;
      text-align: left;
      background: var(--bg-primary);
    }

    .session strong, .session span {
      display: block;
    }

    .session span {
      margin-top: 0.2rem;
      color: var(--text-secondary);
      font-size: 0.68rem;
    }

    .message {
      margin-bottom: 1rem;
      border-radius: 0.65rem;
      padding: 0.75rem 0.9rem;
      background: rgba(88, 245, 210, 0.08);
      color: #bdfcef;
      font-size: 0.78rem;
    }

    .message.error {
      background: rgba(248, 113, 113, 0.1);
      color: #fda4af;
    }

    .empty {
      padding: 2rem;
      text-align: center;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--accent);
    }

    @media (max-width: 900px) {
      .hero {
        display: block;
      }
      .privacy {
        margin-top: 1rem;
      }
      .grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  @state() private sessions: SessionSummary[] = [];
  @state() private session: SessionSummary | null = null;
  @state() private analysis: Analysis | null = null;
  @state() private sessionTitle = '';
  @state() private intent = '';
  @state() private note = '';
  @state() private captureLabel = '';
  @state() private buildTarget = 'skill';
  @state() private narrationState = 'missing';
  @state() private narrationPhase = 'idle';
  @state() private narrationProgress: number | null = null;
  @state() private narrationRecording = false;
  @state() private narrationText = '';
  @state() private busy = false;
  @state() private message = '';
  @state() private error = '';
  private poll?: ReturnType<typeof setInterval>;
  private narrationCleanup?: () => void;
  private mediaRecorder?: MediaRecorder;
  private mediaStream?: MediaStream;
  private audioChunks: Blob[] = [];
  private audioChunkBytes = 0;
  private narrationStartedAt = 0;
  private narrationTimer?: ReturnType<typeof setTimeout>;
  private narrationStopping = false;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    const desktop = desktopBridge();
    if (desktop) {
      this.narrationCleanup = desktop.onNarrationStatus((status) => {
        this.narrationState = String(status.model ?? 'missing');
        this.narrationPhase = String(status.phase ?? 'idle');
        this.narrationProgress =
          typeof status.progress === 'number' ? status.progress : null;
      });
      void desktop.narration({ action: 'status' }).then((status) => {
        this.narrationState = String(status.model ?? 'missing');
        this.narrationPhase = String(status.phase ?? 'idle');
        this.narrationProgress =
          typeof status.progress === 'number' ? status.progress : null;
      }).catch(() => {});
    }
    this.poll = setInterval(() => {
      if (this.session?.state === 'recording' || this.session?.state === 'stopping') {
        void this.refreshStatus();
      }
    }, 1_500);
  }

  disconnectedCallback(): void {
    if (this.poll) clearInterval(this.poll);
    this.narrationCleanup?.();
    this.narrationCleanup = undefined;
    this.mediaRecorder?.stop();
    if (this.narrationTimer) clearTimeout(this.narrationTimer);
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    super.disconnectedCallback();
  }

  private async ensureNarrationModel(): Promise<void> {
    const desktop = desktopBridge();
    if (!desktop) throw new Error('Narration requires OpenRappter Desktop.');
    if (this.narrationState === 'ready') return;
    const status = await desktop.narration({ action: 'download' });
    this.narrationState = String(status.model ?? 'ready');
    this.narrationPhase = String(status.phase ?? 'idle');
  }

  private async startNarration(): Promise<void> {
    if (!this.session || this.session.state !== 'recording') {
      throw new Error('Start a Show-and-Tell recording before narration.');
    }
    await this.ensureNarrationModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: 24_000,
    });
    this.audioChunks = [];
    this.audioChunkBytes = 0;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size <= 0) return;
      this.audioChunks.push(event.data);
      this.audioChunkBytes += event.data.size;
      if (this.audioChunkBytes > 25 * 1024 * 1024) {
        this.error = 'Narration reached the 25 MB local safety limit.';
        void this.stopNarration();
      }
    });
    recorder.start(500);
    this.mediaRecorder = recorder;
    this.mediaStream = stream;
    this.narrationStartedAt = Date.now();
    this.narrationRecording = true;
    this.narrationTimer = setTimeout(() => {
      this.message = 'Narration reached the 10-minute local limit.';
      void this.stopNarration();
    }, 10 * 60_000);
    this.message = 'Narration is recording locally.';
  }

  private async stopNarration(): Promise<void> {
    if (this.narrationStopping) return;
    const recorder = this.mediaRecorder;
    if (!recorder || recorder.state === 'inactive') return;
    this.narrationStopping = true;
    if (this.narrationTimer) {
      clearTimeout(this.narrationTimer);
      this.narrationTimer = undefined;
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    recorder.stop();
    await stopped;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = undefined;
    this.mediaStream = undefined;
    this.narrationRecording = false;

    const audioBlob = new Blob(this.audioChunks, {
      type: recorder.mimeType || 'audio/webm',
    });
    this.audioChunks = [];
    try {
      if (audioBlob.size > 25 * 1024 * 1024) {
        throw new Error('Narration exceeds the 25 MB local safety limit.');
      }
      if (Date.now() - this.narrationStartedAt > 10 * 60_000 + 5_000) {
        throw new Error('Narration exceeds the 10-minute local safety limit.');
      }
      const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
      const context = new AudioContext();
      try {
      const decoded = await context.decodeAudioData(
        audioBytes.buffer.slice(0),
      );
      const samples = this.resampleMono(decoded, 16_000);
      const desktop = desktopBridge()!;
      const transcript = await desktop.narration({
        action: 'transcribe',
        session_id: this.session?.id,
        language: 'en',
        duration_ms: Date.now() - this.narrationStartedAt,
        audio: audioBytes,
        samples: new Uint8Array(samples.buffer),
      });
      this.narrationText = String(transcript.text ?? '');
      this.message = this.narrationText
        ? `Narration transcribed locally: ${this.narrationText}`
        : 'Narration saved locally.';
      } finally {
        await context.close();
      }
    } finally {
      this.narrationStopping = false;
    }
  }

  private resampleMono(
    buffer: AudioBuffer,
    sampleRate: number,
  ): Float32Array {
    const channels = Array.from(
      { length: buffer.numberOfChannels },
      (_, index) => buffer.getChannelData(index),
    );
    const mono = new Float32Array(buffer.length);
    for (let index = 0; index < buffer.length; index += 1) {
      let value = 0;
      for (const channel of channels) value += channel[index] ?? 0;
      mono[index] = value / channels.length;
    }
    if (buffer.sampleRate === sampleRate) return mono;
    const ratio = buffer.sampleRate / sampleRate;
    const output = new Float32Array(Math.max(1, Math.floor(mono.length / ratio)));
    for (let index = 0; index < output.length; index += 1) {
      const position = index * ratio;
      const before = Math.floor(position);
      const after = Math.min(mono.length - 1, before + 1);
      const mix = position - before;
      output[index] = mono[before] * (1 - mix) + mono[after] * mix;
    }
    return output;
  }

  private async call(
    request: DesktopShowAndTellRequest,
    interactive = true,
  ): Promise<Record<string, unknown>> {
    const bridge = desktopBridge();
    if (!bridge) throw new Error('Show-and-Tell desktop controls require the Electron app.');
    if (interactive) {
      this.busy = true;
      this.error = '';
      this.message = '';
    }
    try {
      const result = await bridge.showAndTell(request);
      if (result.status === 'error') {
        throw new Error(String(result.message ?? 'Show-and-Tell action failed.'));
      }
      return result;
    } finally {
      if (interactive) this.busy = false;
    }
  }

  private async act(
    request: DesktopShowAndTellRequest,
    success: string,
  ): Promise<void> {
    try {
      const result = await this.call(request);
      const candidate = result.session as SessionSummary | undefined;
      if (candidate) this.session = candidate;
      const analysis = result.analysis as Analysis | undefined;
      if (analysis) {
        this.analysis = analysis;
        this.intent = analysis.intent;
      }
      this.message = success;
      await this.refresh();
    } catch (error) {
      this.error = (error as Error).message;
    }
  }

  private async refresh(): Promise<void> {
    if (!desktopBridge()) return;
    try {
      const listed = await this.call({ action: 'list' }, false);
      this.sessions = (listed.sessions as SessionSummary[] | undefined) ?? [];
      await this.refreshStatus();
    } catch (error) {
      this.error = (error as Error).message;
    }
  }

  private async refreshStatus(sessionId = this.session?.id): Promise<void> {
    if (!desktopBridge()) return;
    const result = await this.call({
      action: 'status',
      ...(sessionId ? { session_id: sessionId } : {}),
    }, false);
    const previousState = this.session?.state;
    this.session = (result.session as SessionSummary | null | undefined) ?? null;
    if (
      this.narrationRecording &&
      previousState === 'recording' &&
      this.session?.state !== 'recording'
    ) {
      void this.stopNarration().catch((error) => {
        this.error = (error as Error).message;
      });
    }
    const summary = result.analysis as
      | { approved?: boolean; step_count?: number }
      | null
      | undefined;
    const detail = result.analysis_detail as Analysis | null | undefined;
    if (detail) {
      this.analysis = detail;
      this.intent = detail.intent;
    }
    if (!summary && this.session && this.session.state !== 'recording') {
      this.analysis = null;
    }
  }

  private async selectSession(id: string): Promise<void> {
    this.session = this.sessions.find((candidate) => candidate.id === id) ?? null;
    await this.refreshStatus(id);
  }

  private renderUnavailable() {
    return html`
      <div class="shell">
        <div class="card empty">
          <h2>Show-and-Tell lives in OpenRappter Desktop</h2>
          <p>
            Open the Electron app for native recording controls, or use
            <code>openrappter show-and-tell start</code> in a local terminal.
          </p>
        </div>
      </div>
    `;
  }

  render() {
    if (!desktopBridge()) return this.renderUnavailable();
    const recording = this.session?.state === 'recording';
    const completed = Boolean(
      this.session && !['recording', 'stopping'].includes(this.session.state),
    );
    return html`
      <div class="shell">
        <div class="hero">
          <div>
            <div class="eyebrow">Demonstration compiler</div>
            <h2>Show it once. Keep the judgment.</h2>
            <p class="lede">
              Record app/window context, narrate the important decisions, review
              the reconstructed procedure, then create a reusable skill or a
              disabled automation.
            </p>
          </div>
          <div class="privacy">
            Explicit window captures only · typed text is never stored · raw
            frames never go to Copilot · native confirmation guards every
            sensitive action
          </div>
        </div>

        <div data-desktop-private>
        ${this.error ? html`<div class="message error">${this.error}</div>` : nothing}
        ${this.message ? html`<div class="message">${this.message}</div>` : nothing}

        <div class="grid">
          <main>
            <section class="card">
              <div class="card-head">
                <div>
                  <div class="eyebrow">Recorder</div>
                  <h3>${this.session?.title || 'New demonstration'}</h3>
                </div>
                <span class="state ${this.session?.state ?? ''}">
                  <span class="dot"></span>${this.session?.state ?? 'idle'}
                </span>
              </div>

              ${!recording
                ? html`
                    <div class="fields">
                      <label>
                        Session title
                        <input
                          .value=${this.sessionTitle}
                          @input=${(event: InputEvent) => {
                            this.sessionTitle = (event.target as HTMLInputElement).value;
                          }}
                          placeholder="Weekly release workflow"
                        />
                      </label>
                      <label>
                        What are you about to demonstrate?
                        <textarea
                          .value=${this.intent}
                          @input=${(event: InputEvent) => {
                            this.intent = (event.target as HTMLTextAreaElement).value;
                          }}
                          placeholder="Publish a verified release after every required check passes"
                        ></textarea>
                      </label>
                    </div>
                    <div class="actions">
                      <button
                        data-desktop-sensitive="model-download"
                        class="primary"
                        ?disabled=${this.busy || !this.intent.trim()}
                        @click=${() => void this.act(
                          {
                            action: 'start',
                            title: this.sessionTitle,
                            intent: this.intent,
                          },
                          'Recording started.',
                        )}
                      >
                        ● Start recording
                      </button>
                    </div>
                  `
                : html`
                    <div class="row">
                      <label>
                        Narration note
                        <input
                          .value=${this.note}
                          @input=${(event: InputEvent) => {
                            this.note = (event.target as HTMLInputElement).value;
                          }}
                          placeholder="Explain what you are doing and why"
                        />
                      </label>
                      <button
                        data-desktop-sensitive="microphone"
                        ?disabled=${this.busy || !this.note.trim()}
                        @click=${async () => {
                          await this.act(
                            {
                              action: 'note',
                              session_id: this.session?.id,
                              note: this.note,
                            },
                            'Note recorded.',
                          );
                          this.note = '';
                        }}
                      >Add note</button>
                    </div>
                    <div class="row" style="margin-top:.75rem">
                      <label>
                        Reference frame label
                        <input
                          .value=${this.captureLabel}
                          @input=${(event: InputEvent) => {
                            this.captureLabel = (event.target as HTMLInputElement).value;
                          }}
                          placeholder="All required checks are green"
                        />
                      </label>
                      <button
                        ?disabled=${this.busy}
                        @click=${() => void this.act(
                          {
                            action: 'capture',
                            session_id: this.session?.id,
                            title: this.captureLabel,
                          },
                          'Active window captured locally.',
                        )}
                      >Capture window</button>
                    </div>
                    <div class="card" style="margin-top:.75rem;box-shadow:none">
                      <div class="card-head">
                        <div>
                          <div class="eyebrow">Tell · local Whisper</div>
                          <strong>
                            ${this.narrationRecording
                              ? 'Listening…'
                              : this.narrationState === 'ready'
                                ? 'Ready for narration'
                                : 'Model download required'}
                          </strong>
                        </div>
                        <span class="state">
                          ${this.narrationPhase}
                          ${this.narrationProgress === null
                            ? nothing
                            : ` · ${Math.round(this.narrationProgress)}%`}
                        </span>
                      </div>
                      ${this.narrationText
                        ? html`<p class="lede">${this.narrationText}</p>`
                        : nothing}
                      <div class="actions">
                        ${this.narrationState !== 'ready'
                          ? html`
                              <button
                                ?disabled=${this.busy || this.narrationPhase !== 'idle'}
                                @click=${() => void this.ensureNarrationModel()
                                  .catch((error) => {
                                    this.error = (error as Error).message;
                                  })}
                              >Download Whisper (~252 MB)</button>
                            `
                          : nothing}
                        <button
                          class=${this.narrationRecording ? 'danger' : ''}
                          ?disabled=${this.busy || this.narrationPhase === 'loading'}
                          @click=${() => void (
                            this.narrationRecording
                              ? this.stopNarration()
                              : this.startNarration()
                          ).catch((error) => {
                            this.error = (error as Error).message;
                          })}
                        >
                          ${this.narrationRecording ? 'Stop & transcribe' : 'Start narration'}
                        </button>
                      </div>
                    </div>
                    <div class="actions">
                      <button
                        class="danger"
                        ?disabled=${this.busy}
                        @click=${() => void (async () => {
                          if (this.narrationRecording) await this.stopNarration();
                          await this.act(
                            { action: 'stop', session_id: this.session?.id },
                            'Recording stopped.',
                          );
                        })()}
                      >■ Stop recording</button>
                    </div>
                  `}
            </section>

            ${completed
              ? html`
                  <section class="card">
                    <div class="card-head">
                      <div>
                        <div class="eyebrow">Analysis</div>
                        <h3>${this.analysis?.title ?? 'Ready to reconstruct'}</h3>
                      </div>
                      ${this.analysis
                        ? html`<span class="state">${this.analysis.approved ? 'approved' : 'draft'}</span>`
                        : nothing}
                    </div>
                    ${!this.analysis
                      ? html`
                          <button
                            class="primary"
                            ?disabled=${this.busy}
                            @click=${async () => {
                              try {
                                const result = await this.call({
                                  action: 'analyze',
                                  session_id: this.session?.id,
                                });
                                this.analysis = result.analysis as Analysis;
                                this.intent = this.analysis.intent;
                                this.message = 'Analysis ready for review.';
                              } catch (error) {
                                this.error = (error as Error).message;
                              }
                            }}
                          >Analyze demonstration</button>
                        `
                      : html`
                          <label>
                            Reviewed intent
                            <textarea
                              .value=${this.intent}
                              @input=${(event: InputEvent) => {
                                this.intent = (event.target as HTMLTextAreaElement).value;
                              }}
                            ></textarea>
                          </label>
                          <div class="steps">
                            ${this.analysis.steps.map((step, index) => html`
                              <div class="step">
                                <div class="step-number">${index + 1}</div>
                                <div>
                                  <strong>${step.title}</strong>
                                  <p>${step.detail}</p>
                                  ${step.tool ? html`<span class="tool">${step.tool}</span>` : nothing}
                                </div>
                              </div>
                            `)}
                          </div>
                          <div class="actions">
                            <button
                              ?disabled=${this.busy}
                              @click=${() => void this.act(
                                {
                                  action: 'review',
                                  session_id: this.session?.id,
                                  intent: this.intent,
                                },
                                'Draft updated.',
                              )}
                            >Save draft</button>
                            <button
                              class="primary"
                              ?disabled=${this.busy || this.analysis.approved}
                              @click=${() => void this.act(
                                {
                                  action: 'review',
                                  session_id: this.session?.id,
                                  intent: this.intent,
                                  approve: true,
                                },
                                'Workflow approved.',
                              )}
                            >Approve workflow</button>
                          </div>
                        `}
                  </section>

                  ${this.analysis?.approved
                    ? html`
                        <section class="card">
                          <div class="card-head">
                            <div>
                              <div class="eyebrow">Package</div>
                              <h3>Build reusable behavior</h3>
                            </div>
                          </div>
                          <div class="row">
                            <label>
                              Artifact
                              <select
                                .value=${this.buildTarget}
                                @change=${(event: Event) => {
                                  this.buildTarget = (event.target as HTMLSelectElement).value;
                                }}
                              >
                                <option value="skill">Skill</option>
                                <option value="automation">Automation</option>
                                <option value="all">Skill + automation</option>
                              </select>
                            </label>
                            <button
                              class="primary"
                              ?disabled=${this.busy}
                              @click=${() => void this.act(
                                {
                                  action: 'build',
                                  session_id: this.session?.id,
                                  target: this.buildTarget,
                                },
                                'Artifacts built and installed.',
                              )}
                            >Build</button>
                          </div>
                          <div class="actions">
                            <button
                              ?disabled=${this.busy}
                              @click=${() => void this.act(
                                { action: 'replay', session_id: this.session?.id },
                                'Dry-run replay plan is valid.',
                              )}
                            >Preview replay</button>
                            <button
                              ?disabled=${this.busy}
                              @click=${() => void this.act(
                                { action: 'test', session_id: this.session?.id },
                                'Artifact validation passed.',
                              )}
                            >Validate artifacts</button>
                          </div>
                        </section>
                      `
                    : nothing}
                `
              : nothing}
          </main>

          <aside>
            <section class="card">
              <div class="card-head">
                <div>
                  <div class="eyebrow">Library</div>
                  <h3>Demonstrations</h3>
                </div>
              </div>
              ${this.sessions.length
                ? this.sessions.map((candidate) => html`
                    <button
                      class="session"
                      @click=${() => void this.selectSession(candidate.id)}
                    >
                      <strong>${candidate.title || candidate.intentHint || candidate.id}</strong>
                      <span>${candidate.state} · ${new Date(candidate.startedAt).toLocaleString()}</span>
                    </button>
                  `)
                : html`<p class="empty">No demonstrations yet.</p>`}
            </section>
          </aside>
        </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-show-and-tell': OpenRappterShowAndTell;
  }
}
