import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { gateway, type GatewayClient } from '../services/gateway.js';
import {
  FixtureReleaseRingAdapter,
  ONBOARDING_STEPS,
  RELEASE_RINGS,
  isOnboardingStep,
  isReleaseRing,
  type OnboardingStep,
  type ReleaseRing,
  type ReleaseRingAdapter,
} from '../services/xpedition.js';
import {
  ActionBoundApprovalGate,
  type CompanyApprovalRequest,
} from '../services/living-company.js';
import type { CopilotReadinessSnapshot } from '../services/copilot-readiness.js';

interface HealthResult {
  status: 'ok' | 'degraded' | 'error';
  version?: string;
  checks?: Record<string, boolean>;
  timestamp?: string;
}

export async function runFirstHealthCheck(
  client: Pick<GatewayClient, 'call' | 'isConnected'> = gateway,
): Promise<HealthResult> {
  if (!client.isConnected) {
    throw new Error('The local gateway is disconnected. Reconnect before running the health check.');
  }
  const result = await client.call<HealthResult>('health');
  if (!result || !['ok', 'degraded', 'error'].includes(result.status)) {
    throw new Error('The gateway returned an invalid health response.');
  }
  return result;
}

@customElement('openrappter-xpedition-onboarding')
export class OpenRappterXpeditionOnboarding extends LitElement {
  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      z-index: 20000;
      display: grid;
      place-items: center;
      padding: clamp(0.75rem, 4vw, 3rem);
      background: rgba(7, 27, 52, 0.58);
      backdrop-filter: blur(12px);
      color: #13253c;
    }

    .wizard {
      width: min(860px, 100%);
      min-height: min(620px, calc(100vh - 2rem));
      display: grid;
      grid-template-columns: 210px minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid #153b78;
      border-radius: 0.9rem;
      background: #f7fbff;
      box-shadow: 0 30px 90px rgba(3, 20, 45, 0.55);
    }

    aside {
      padding: 1.5rem 1rem;
      color: white;
      background:
        radial-gradient(circle at 15% 20%, rgba(118, 222, 255, 0.4), transparent 12rem),
        linear-gradient(155deg, #173f83, #0a64a2 55%, #0b765e);
    }

    .edition {
      display: block;
      margin-bottom: 1.8rem;
      font-size: 0.78rem;
      line-height: 1.45;
      letter-spacing: 0.02em;
    }

    .edition strong {
      display: block;
      font-size: 1rem;
    }

    ol {
      display: grid;
      gap: 0.45rem;
      list-style: none;
    }

    .step {
      display: flex;
      gap: 0.55rem;
      align-items: center;
      padding: 0.45rem 0.55rem;
      border-radius: 0.45rem;
      font-size: 0.78rem;
      opacity: 0.74;
    }

    .step.current {
      background: rgba(255, 255, 255, 0.18);
      opacity: 1;
      font-weight: 700;
    }

    .step-number {
      width: 1.35rem;
      height: 1.35rem;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.6);
      border-radius: 50%;
      font-size: 0.66rem;
    }

    main {
      display: flex;
      min-width: 0;
      flex-direction: column;
      padding: clamp(1.4rem, 4vw, 2.7rem);
    }

    h1 {
      margin: 0 0 0.5rem;
      font-family: Georgia, 'Times New Roman', serif;
      font-size: clamp(1.75rem, 4vw, 2.8rem);
      line-height: 1.04;
      color: #14376d;
    }

    h2 {
      margin: 0 0 0.55rem;
      font-size: 1.35rem;
      color: #14376d;
    }

    p {
      max-width: 62ch;
      margin: 0.4rem 0;
      line-height: 1.62;
    }

    .subtitle {
      margin-bottom: 1.5rem;
      color: #41617d;
      font-weight: 650;
    }

    .panel {
      margin-top: 1rem;
      padding: 1rem;
      border: 1px solid #bdd2e9;
      border-radius: 0.6rem;
      background: #edf6ff;
    }

    .status {
      display: flex;
      align-items: flex-start;
      gap: 0.65rem;
      margin-top: 0.8rem;
      padding: 0.8rem;
      border: 1px solid #9dbad6;
      border-radius: 0.5rem;
      background: white;
    }

    .status.error {
      border-color: #b73b43;
      background: #fff3f3;
      color: #7a1520;
    }

    .status.warning {
      border-color: #bb7b00;
      background: #fff8df;
      color: #6a4500;
    }

    .status.ok {
      border-color: #3a825a;
      background: #effbf3;
      color: #164f31;
    }

    label {
      display: grid;
      gap: 0.35rem;
      margin-top: 1rem;
      font-weight: 700;
    }

    select {
      width: min(320px, 100%);
      padding: 0.7rem;
      border: 1px solid #52759a;
      border-radius: 0.4rem;
      background: white;
      color: #13253c;
      font: inherit;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.6rem;
      margin-top: auto;
      padding-top: 2rem;
    }

    button.legacy {
      margin-right: auto;
      border-color: #725518;
      background: #fff7d6;
      color: #4f3908;
    }

    .modal-status {
      min-height: 1.2rem;
      margin-top: 0.4rem;
      color: #6a4500;
      font-size: 0.75rem;
      font-weight: 700;
    }

    button {
      min-height: 2.55rem;
      padding: 0.55rem 1rem;
      border: 1px solid #315e91;
      border-radius: 0.45rem;
      background: linear-gradient(#fff, #dcecff);
      color: #15375e;
      font: 700 0.84rem/1 inherit;
      cursor: pointer;
    }

    button.primary {
      border-color: #1e6c3e;
      background: linear-gradient(#5dbf78, #278146);
      color: white;
    }

    button:disabled {
      cursor: not-allowed;
      filter: grayscale(0.8);
      opacity: 0.55;
    }

    button:focus-visible,
    select:focus-visible {
      outline: 3px solid #ffbf47;
      outline-offset: 2px;
    }

    code {
      border-radius: 0.25rem;
      background: #dfeaf5;
      padding: 0.12rem 0.3rem;
    }

    .checks {
      display: grid;
      gap: 0.3rem;
      margin-top: 0.55rem;
      padding-left: 0;
      list-style: none;
    }

    @media (max-width: 680px) {
      :host { padding: 0; }
      .wizard {
        min-height: 100vh;
        grid-template-columns: 1fr;
        border: 0;
        border-radius: 0;
      }
      aside {
        padding: 0.8rem 1rem;
      }
      .edition { margin: 0; }
      aside ol { display: none; }
      main { padding: 1.25rem; }
    }

    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; }
    }
  `;

  @property({ type: Boolean }) connected = false;
  @property({ type: String }) connectionError = '';
  @property({ attribute: false }) copilotReadiness: CopilotReadinessSnapshot = {
    state: 'unknown',
    message: 'Copilot readiness has not been checked.',
  };
  @property({ attribute: false }) ringAdapter: ReleaseRingAdapter =
    new FixtureReleaseRingAdapter();

  @state() private step: OnboardingStep = 'welcome';
  @state() private ring: ReleaseRing = 'stable';
  @state() private appliedRing: ReleaseRing = 'stable';
  @state() private ringMessage = '';
  @state() private ringMessageKind: 'ok' | 'error' | 'warning' | '' = '';
  @state() private pendingRingApproval:
    | { request: CompanyApprovalRequest; ring: ReleaseRing }
    | null = null;
  @state() private skillsState: 'idle' | 'loading' | 'success' | 'error' = 'idle';
  @state() private skillsMessage = '';
  @state() private healthState: 'idle' | 'loading' | 'success' | 'error' = 'idle';
  @state() private health: HealthResult | null = null;
  @state() private healthError = '';
  @state() private modalStatus = '';
  @query('.wizard') private wizard?: HTMLElement;
  private previousFocus: HTMLElement | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    void this.ringAdapter.current().then((ring) => {
      this.ring = ring;
      this.appliedRing = ring;
    });
  }

  protected firstUpdated(): void {
    queueMicrotask(() => this.wizard?.focus());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  selectStep(step: OnboardingStep): void {
    if (!isOnboardingStep(step)) throw new Error(`Unknown onboarding step: ${String(step)}`);
    this.step = step;
  }

  get currentStep(): OnboardingStep {
    return this.step;
  }

  private get stepIndex(): number {
    return ONBOARDING_STEPS.indexOf(this.step);
  }

  private previous(): void {
    if (this.stepIndex > 0) this.step = ONBOARDING_STEPS[this.stepIndex - 1];
  }

  private next(): void {
    if (this.step === 'gateway' && !this.connected) return;
    if (this.step === 'release' && this.ring !== this.appliedRing) return;
    if (this.stepIndex < ONBOARDING_STEPS.length - 1) {
      this.step = ONBOARDING_STEPS[this.stepIndex + 1];
    }
  }

  private requestReconnect(): void {
    this.dispatchEvent(new CustomEvent('retry-gateway', {
      bubbles: true,
      composed: true,
    }));
  }

  private async discoverSkills(): Promise<void> {
    this.skillsState = 'loading';
    this.skillsMessage = '';
    try {
      const skills = await gateway.call<unknown[]>('skills.list');
      const count = Array.isArray(skills) ? skills.length : 0;
      this.skillsState = 'success';
      this.skillsMessage = `${count} installed skill${count === 1 ? '' : 's'} discovered.`;
    } catch (error) {
      this.skillsState = 'error';
      this.skillsMessage = error instanceof Error ? error.message : String(error);
    }
  }

  private async applyRing(): Promise<void> {
    if (!this.pendingRingApproval) return;
    const pending = this.pendingRingApproval;
    this.releaseApprovals.resolve(
      pending.request.id,
      'release.apply',
      true,
      true,
    );
    this.releaseApprovals.consume(
      pending.request.id,
      'release.apply',
    );
    const result = await this.ringAdapter.apply(pending.ring);
    this.ringMessage = result.message;
    this.ringMessageKind = result.status === 'applied'
      ? 'ok'
      : result.status === 'unavailable'
        ? 'warning'
        : 'error';
    if (result.status === 'applied') {
      this.appliedRing = result.ring;
      this.dispatchEvent(new CustomEvent('release-ring-change', {
        detail: { ring: result.ring },
        bubbles: true,
        composed: true,
      }));
    }
    this.pendingRingApproval = null;
  }

  private readonly releaseApprovals = new ActionBoundApprovalGate();

  private requestRingApproval(): void {
    this.pendingRingApproval = {
      request: this.releaseApprovals.request(
        'release.apply',
        `Apply ${this.ring} release ring during onboarding`,
      ),
      ring: this.ring,
    };
  }

  private rejectRingApproval(): void {
    if (!this.pendingRingApproval) return;
    this.releaseApprovals.resolve(
      this.pendingRingApproval.request.id,
      'release.apply',
      false,
      true,
    );
    this.ringMessage = 'Release-ring Apply / Update was rejected. Nothing changed.';
    this.ringMessageKind = 'warning';
    this.pendingRingApproval = null;
  }

  private async runHealth(): Promise<void> {
    this.healthState = 'loading';
    this.healthError = '';
    this.health = null;
    try {
      this.health = await runFirstHealthCheck();
      if (this.health.status === 'error') {
        this.healthState = 'error';
        this.healthError = 'The gateway reported an unhealthy state. Review the failed checks and retry.';
      } else {
        this.healthState = 'success';
      }
    } catch (error) {
      this.healthState = 'error';
      this.healthError = error instanceof Error ? error.message : String(error);
    }
  }

  private finish(): void {
    if (
      this.healthState !== 'success' ||
      this.copilotReadiness.state !== 'ready'
    ) {
      return;
    }
    this.dispatchEvent(new CustomEvent('onboarding-complete', {
      detail: { releaseRing: this.appliedRing },
      bubbles: true,
      composed: true,
    }));
  }

  private renderCopilotReadiness() {
    const ready = this.copilotReadiness.state === 'ready';
    const error = [
      'needs-sign-in',
      'no-entitlement',
      'offline',
      'error',
    ].includes(this.copilotReadiness.state);
    return html`
      <div
        class="status ${ready ? 'ok' : error ? 'error' : 'warning'}"
        role=${error ? 'alert' : 'status'}
        aria-live=${error ? 'assertive' : 'polite'}
      >
        <div>
          <strong>Copilot: ${this.copilotReadiness.state}</strong>
          <p>${this.copilotReadiness.message}</p>
          ${this.copilotReadiness.state === 'needs-sign-in'
            ? html`
                <button
                  data-desktop-sensitive="copilot-sign-in"
                  @click=${() => this.dispatchEvent(new CustomEvent(
                  'copilot-sign-in',
                  { bubbles: true, composed: true },
                ))}
                >Sign in to Copilot</button>
              `
            : !ready
              ? html`
                  <button
                    ?disabled=${this.copilotReadiness.state === 'checking'}
                    @click=${() => this.dispatchEvent(new CustomEvent(
                      'check-copilot',
                      { bubbles: true, composed: true },
                    ))}
                  >Check Copilot readiness</button>
                `
              : nothing}
        </div>
      </div>
    `;
  }

  private useLegacy(): void {
    this.dispatchEvent(new CustomEvent('switch-shell', {
      detail: { shell: 'legacy' },
      bubbles: true,
      composed: true,
    }));
  }

  private handleDialogKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.modalStatus =
        'Setup remains open to preserve state. Use Legacy OpenRappter is focused.';
      this.shadowRoot?.querySelector<HTMLButtonElement>('.legacy')?.focus();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      this.shadowRoot?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute('inert'));
    if (focusable.length === 0) {
      event.preventDefault();
      this.wizard?.focus();
      return;
    }
    const active = this.shadowRoot?.activeElement;
    const current = focusable.indexOf(active as HTMLElement);
    if (event.shiftKey && (current <= 0)) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    } else if (!event.shiftKey && current === focusable.length - 1) {
      event.preventDefault();
      focusable[0].focus();
    } else if (current < 0) {
      event.preventDefault();
      (event.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
    }
  }

  private renderStep() {
    switch (this.step) {
      case 'welcome':
        return html`
          <h1>Welcome, clever girl.</h1>
          <p class="subtitle">A calm local desktop for capable agents.</p>
          <p>
            OpenRappter Personal is the free/open default organism.
            Rapter's Clever Girl Edition and Windows XPedition keep every
            existing gateway capability under one keyboard-friendly shell.
          </p>
          <div class="panel">
            <strong>Original by design.</strong>
            <p>
              The landscape, chrome, symbols, and sounds are OpenRappter
              originals. No Microsoft logos, Bliss artwork, proprietary icons,
              or copied binary assets are included.
            </p>
          </div>
        `;
      case 'privacy':
        return html`
          <h2>Local-first means local first</h2>
          <p>
            Your agent state, configuration, memory, and flight records remain
            in your OpenRappter installation. This wizard stores only your
            explicit shell, contrast, completion, and release-ring preferences.
          </p>
          <div class="panel">
            <strong>Secrets are not wizard preferences.</strong>
            <p>
              Channel credentials and gateway authentication continue through
              their existing protected flows. This shell does not read or copy
              them into browser storage.
            </p>
          </div>
        `;
      case 'gateway':
        return html`
          <h2>Connect the local gateway</h2>
          <p>The desktop uses the same authenticated WebSocket RPC client as the legacy dashboard.</p>
          <div class="status ${this.connected ? 'ok' : 'error'}" role="status" aria-live="polite">
            <strong>${this.connected ? 'Connected' : 'Disconnected'}</strong>
            <span>
              ${this.connected
                ? 'The real OpenRappter gateway accepted this client.'
                : this.connectionError || 'Waiting for a truthful gateway handshake.'}
            </span>
          </div>
          ${this.connected
            ? nothing
            : html`<button @click=${this.requestReconnect}>Retry connection</button>`}
          ${this.renderCopilotReadiness()}
        `;
      case 'release':
        return html`
          <h2>Choose a release ring</h2>
          <p>Stable is the default. Preview rings can be less tested or older than your current build.</p>
          <label>
            Release ring
            <select
              aria-label="Release ring"
              ?disabled=${Boolean(this.pendingRingApproval)}
              .value=${this.ring}
              @change=${(event: Event) => {
                const value = (event.target as HTMLSelectElement).value;
                if (isReleaseRing(value)) {
                  this.ring = value;
                  this.ringMessage = '';
                }
              }}
            >
              ${RELEASE_RINGS.map((ring) => html`<option value=${ring}>${ring}</option>`)}
            </select>
          </label>
          ${this.ring !== 'stable'
            ? html`
                <div class="status warning" role="alert">
                  <strong>Preview ring</strong>
                  <span>${this.ring} may be less stable or older. Nothing changes until Apply / Update succeeds.</span>
                </div>
              `
            : nothing}
          ${this.ring !== this.appliedRing
            ? html`<button @click=${this.requestRingApproval}>Request Apply / Update ${this.ring}</button>`
            : nothing}
          ${this.ringMessage
            ? html`<div class="status ${this.ringMessageKind}" role="status" aria-live="polite">${this.ringMessage}</div>`
            : nothing}
          ${this.pendingRingApproval
            ? html`
                <div class="status warning" role="alert">
                  <div>
                    <strong>Action-bound confirmation</strong>
                    <p><code>${this.pendingRingApproval.request.actionFingerprint}</code></p>
                    <button
                      data-desktop-sensitive="company-approval"
                      @click=${() => void this.applyRing()}
                    >Confirm Apply / Update</button>
                    <button
                      data-desktop-sensitive="company-approval"
                      @click=${this.rejectRingApproval}
                    >Reject</button>
                  </div>
                </div>
              `
            : nothing}
        `;
      case 'skills':
        return html`
          <h2>Discover your skills</h2>
          <p>
            Discovery asks the real gateway for installed local and ClawHub
            skills. Import and installation remain in the existing Skills
            surface so its normal validation and approvals stay intact.
          </p>
          <button ?disabled=${this.skillsState === 'loading'} @click=${() => void this.discoverSkills()}>
            ${this.skillsState === 'loading' ? 'Discovering…' : 'Discover installed skills'}
          </button>
          ${this.skillsMessage
            ? html`
                <div
                  class="status ${this.skillsState === 'error' ? 'error' : 'ok'}"
                  role="status"
                  aria-live="polite"
                >${this.skillsMessage}</div>
              `
            : nothing}
        `;
      case 'channels':
        return html`
          <h2>Channels are optional</h2>
          <p>
            You can connect Teams, Slack, Discord, iMessage, or another
            installed channel later from the real Channels window.
          </p>
          <div class="panel">
            <strong>No credentials are collected here.</strong>
            <p>Select <em>Channels</em> from Start after setup to use the gateway's existing setup flow.</p>
          </div>
        `;
      case 'health':
        return html`
          <h2>First health check</h2>
          <p>Before setup completes, ask the gateway for its real <code>health</code> result.</p>
          <button
            ?disabled=${this.healthState === 'loading'}
            @click=${() => void this.runHealth()}
          >${this.healthState === 'loading' ? 'Checking…' : 'Run health check'}</button>
          ${this.health
            ? html`
                <div
                  class="status ${this.healthState === 'success' ? 'ok' : 'error'}"
                  role="status"
                  aria-live="polite"
                >
                  <div>
                    <strong>Gateway: ${this.health.status}</strong>
                    ${this.health.version ? html`<p>Version ${this.health.version}</p>` : nothing}
                    ${this.health.checks
                      ? html`<ul class="checks">
                          ${Object.entries(this.health.checks).map(([name, passing]) =>
                            html`<li>${passing ? 'Pass' : 'Fail'} — ${name}</li>`)}
                        </ul>`
                      : nothing}
                  </div>
                </div>
              `
            : nothing}
          ${this.healthError
            ? html`<div class="status error" role="alert" aria-live="assertive">${this.healthError}</div>`
            : nothing}
          ${this.renderCopilotReadiness()}
        `;
    }
  }

  render() {
    const atLastStep = this.step === 'health';
    return html`
      <section
        class="wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        aria-describedby="wizard-subtitle wizard-status"
        tabindex="-1"
        @keydown=${this.handleDialogKeydown}
      >
        <aside>
          <span class="edition">
            <strong>OpenRappter Personal</strong>
            Rapter's Clever Girl Edition · Windows XPedition
          </span>
          <ol aria-label="Setup progress">
            ${ONBOARDING_STEPS.map((step, index) => html`
              <li class="step ${this.step === step ? 'current' : ''}" aria-current=${this.step === step ? 'step' : nothing}>
                <span class="step-number">${index + 1}</span>
                ${step[0].toUpperCase()}${step.slice(1)}
              </li>
            `)}
          </ol>
        </aside>
        <main>
          <span id="wizard-title" class="subtitle">Windows XPedition setup</span>
          <span id="wizard-subtitle" class="subtitle">
            Local-first setup. You can return to Legacy OpenRappter at any time.
          </span>
          ${this.renderStep()}
          <div id="wizard-status" class="modal-status" role="status" aria-live="polite">
            ${this.modalStatus}
          </div>
          <div class="actions">
            <button class="legacy" @click=${this.useLegacy}>
              Use Legacy OpenRappter
            </button>
            <button ?disabled=${this.stepIndex === 0} @click=${this.previous}>Back</button>
            ${atLastStep
              ? html`
                  <button
                    class="primary"
                    ?disabled=${this.healthState !== 'success' ||
                      this.copilotReadiness.state !== 'ready'}
                    @click=${this.finish}
                  >Land on desktop</button>
                `
              : html`
                  <button
                    class="primary"
                    ?disabled=${(this.step === 'gateway' && !this.connected) ||
                      (this.step === 'release' && this.ring !== this.appliedRing)}
                    @click=${this.next}
                  >Next</button>
                `}
          </div>
        </main>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-xpedition-onboarding': OpenRappterXpeditionOnboarding;
  }
}
