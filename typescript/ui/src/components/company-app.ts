import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  COMPANY_APP_IDS,
  companyAppRegistration,
  isCompanyAppId,
  type CompanyAppId,
} from '../services/company-app-registry.js';
import {
  GatewayCompanyDataAdapter,
  livingCompanyDraftStore,
  livingCompanyScenario,
  type CompanyAppSnapshot,
  type ExternalAction,
} from '../services/living-company.js';

@customElement('openrappter-company-app')
export class OpenRappterCompanyApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--text-primary);
    }

    * { box-sizing: border-box; }

    header {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.15rem 1.25rem;
      border-bottom: 1px solid var(--border);
      background:
        linear-gradient(120deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 55%),
        var(--bg-secondary);
    }

    h2, h3, p { margin: 0; }
    h2 { font: 700 1.25rem/1.15 Georgia, serif; }
    h3 { margin-bottom: 0.6rem; font-size: 0.9rem; }

    .subtitle {
      margin-top: 0.25rem;
      color: var(--text-secondary);
      font-size: 0.78rem;
      line-height: 1.45;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0.35rem 0.65rem;
      background: var(--bg-primary);
      font-size: 0.7rem;
      font-weight: 800;
      text-transform: uppercase;
    }

    .status::before {
      content: '';
      width: 0.55rem;
      height: 0.55rem;
      border-radius: 50%;
      background: var(--warning);
    }

    .status.ready::before { background: var(--accent); }
    .status.offline::before,
    .status.unavailable::before { background: var(--error); }

    .body {
      display: grid;
      gap: 1rem;
      padding: 1rem 1.25rem 1.5rem;
    }

    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      gap: 0.65rem;
    }

    .fact, .panel {
      border: 1px solid var(--border);
      border-radius: 0.55rem;
      background: var(--bg-secondary);
      padding: 0.8rem;
    }

    .fact strong {
      display: block;
      margin-top: 0.2rem;
      font-size: 1.15rem;
    }

    .label, .source {
      color: var(--text-secondary);
      font-size: 0.68rem;
    }

    .source { margin-top: 0.45rem; font-family: monospace; }

    .unavailable {
      display: grid;
      gap: 0.45rem;
      border-color: color-mix(in srgb, var(--warning) 58%, var(--border));
      background: color-mix(in srgb, var(--warning) 10%, var(--bg-secondary));
      line-height: 1.5;
    }

    .unavailable p {
      font-size: 0.76rem;
    }

    .seams {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-top: 0.55rem;
    }

    code {
      border-radius: 0.25rem;
      padding: 0.16rem 0.35rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: 0.68rem;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    button {
      min-height: 2.25rem;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      padding: 0.45rem 0.75rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font: 700 0.72rem/1 inherit;
      cursor: pointer;
    }

    button.primary {
      border-color: color-mix(in srgb, var(--accent) 70%, #14542c);
      background: color-mix(in srgb, var(--accent) 75%, #14542c);
      color: var(--accent-foreground);
    }

    button.danger {
      border-color: var(--error);
      color: var(--error);
    }

    button:focus-visible {
      outline: 3px solid #ffbd2e;
      outline-offset: 2px;
    }

    .timeline {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 0.35rem;
      margin-top: 0.65rem;
    }

    .day {
      border: 1px solid var(--border);
      border-radius: 0.35rem;
      padding: 0.45rem 0.2rem;
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-size: 0.65rem;
      text-align: center;
    }

    .day.done {
      border-color: var(--accent);
      color: var(--text-primary);
      font-weight: 800;
    }

    .approval {
      margin-top: 0.75rem;
      border: 1px solid var(--warning);
      border-radius: 0.45rem;
      padding: 0.7rem;
      background: color-mix(in srgb, var(--warning) 10%, var(--bg-primary));
    }

    .approval p {
      margin-bottom: 0.55rem;
      font-size: 0.76rem;
      line-height: 1.45;
    }

    .draft-list {
      display: grid;
      gap: 0.55rem;
    }

    .draft {
      border-left: 3px solid var(--accent);
      padding: 0.55rem 0.7rem;
      background: var(--bg-primary);
      font-size: 0.74rem;
      line-height: 1.45;
    }

    .draft strong { display: block; margin-bottom: 0.2rem; }

    .empty, .error {
      padding: 2rem;
      color: var(--text-secondary);
      text-align: center;
    }

    .error {
      color: var(--error);
    }

    @media (max-width: 620px) {
      .timeline { grid-template-columns: 1fr; }
    }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `;

  @property({ type: String }) appId: CompanyAppId = 'engineering';
  @property({ attribute: false }) dataAdapter = new GatewayCompanyDataAdapter();
  @state() private snapshot: CompanyAppSnapshot | null = null;
  @state() private loading = true;
  @state() private error = '';
  @state() private copied = '';

  connectedCallback(): void {
    super.connectedCallback();
    globalThis.addEventListener(
      'openrappter-living-company-change',
      this.handleCompanyChange,
    );
    void this.refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    globalThis.removeEventListener(
      'openrappter-living-company-change',
      this.handleCompanyChange,
    );
  }

  private handleCompanyChange = (): void => {
    void this.refresh();
  };

  async refresh(): Promise<void> {
    if (!isCompanyAppId(this.appId)) {
      this.error = `Unknown Living Company app: ${String(this.appId)}`;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = '';
    this.snapshot = await this.dataAdapter.load(this.appId);
    this.loading = false;
  }

  private openApp(appId: string): void {
    this.dispatchEvent(new CustomEvent('open-xpedition-app', {
      detail: { appId },
      bubbles: true,
      composed: true,
    }));
  }

  private async copy(label: string, text: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard permission is unavailable.');
      }
      await navigator.clipboard.writeText(text);
      this.copied = `${label} copied locally. Nothing was published.`;
    } catch (error) {
      this.copied = error instanceof Error ? error.message : String(error);
    }
  }

  private async startScenario(): Promise<void> {
    livingCompanyScenario.start();
    await livingCompanyScenario.runUntilBlocked();
    this.notifyScenario();
  }

  private async advanceScenario(): Promise<void> {
    await livingCompanyScenario.step();
    this.notifyScenario();
  }

  private async runScenario(): Promise<void> {
    await livingCompanyScenario.runUntilBlocked();
    this.notifyScenario();
  }

  private approveScenario(approved: boolean): void {
    const request = livingCompanyScenario.snapshot().pendingApproval;
    if (!request) return;
    livingCompanyScenario.approve(
      request.id,
      request.action as ExternalAction,
      approved,
      true,
    );
    this.notifyScenario();
  }

  private notifyScenario(): void {
    globalThis.dispatchEvent(new CustomEvent('openrappter-living-company-change'));
    this.requestUpdate();
  }

  private relatedActions() {
    const actions: Partial<Record<CompanyAppId, Array<[string, string]>>> = {
      engineering: [
        ['Agent Explorer', 'agents'],
        ['Debug Console', 'debug'],
      ],
      'release-operations': [['Settings & Release Ring', 'settings']],
      'customer-signals': [
        ['Channels', 'channels'],
        ['Sessions', 'sessions'],
      ],
      documentation: [['Flight Recorder', 'flight']],
      'rapp-estate-health': [['Skills', 'skills']],
    };
    return actions[this.appId] ?? [];
  }

  private renderScenario() {
    if (this.appId !== 'decisions') return nothing;
    const scenario = livingCompanyScenario.snapshot();
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    return html`
      <section class="panel" aria-labelledby="week-heading">
        <h3 id="week-heading">Living Company Week · fixture mode</h3>
        <p class="subtitle">
          Deterministic local scenario. External sends, publishes, submissions,
          commands, and releases stay at zero.
        </p>
        <div class="timeline" aria-label="Scenario week progress">
          ${days.map((day) => html`
            <span class="day ${scenario.completedDays.includes(day as never) ? 'done' : ''}">
              ${day}
            </span>
          `)}
        </div>
        <div class="actions" style="margin-top:.7rem">
          <button @click=${() => void this.startScenario()}>Start / Reset fixture week</button>
          <button @click=${() => void this.advanceScenario()}>Advance one step</button>
          <button class="primary" @click=${() => void this.runScenario()}>Run until blocker</button>
        </div>
        ${scenario.pendingApproval
          ? html`
              <div class="approval" role="alert">
                <p>
                  <strong>Human confirmation required:</strong>
                  ${scenario.pendingApproval.summary}
                  (<code>${scenario.pendingApproval.action}</code>)
                </p>
                <div class="actions">
                  <button
                    class="primary"
                    data-desktop-sensitive="company-approval"
                    @click=${() => this.approveScenario(true)}
                  >Approve this fixture action</button>
                  <button
                    class="danger"
                    data-desktop-sensitive="company-approval"
                    @click=${() => this.approveScenario(false)}
                  >Reject</button>
                </div>
              </div>
            `
          : nothing}
        <p class="subtitle" style="margin-top:.7rem" aria-live="polite">
          Status: ${scenario.status}. Evidence entries: ${scenario.ledger.length}.
          External side effects: ${scenario.externalSideEffects}.
        </p>
        ${scenario.ledger.length > 0
          ? html`
              <div class="draft-list" style="margin-top:.7rem" aria-label="Redacted evidence ledger">
                ${scenario.ledger.map((entry) => html`
                  <div class="draft">
                    <strong>${entry.sequence}. ${entry.day} · ${entry.event}</strong>
                    ${entry.status}
                    <div class="source">${entry.timestamp} · redacted bounded evidence</div>
                  </div>
                `)}
              </div>
            `
          : nothing}
      </section>
    `;
  }

  private renderPrivateDrafts() {
    if (this.appId !== 'expenses' && this.appId !== 'decisions') return nothing;
    const state = livingCompanyDraftStore.snapshot();
    if (this.appId === 'expenses') {
      return html`
        <section class="panel" data-desktop-private aria-labelledby="expense-drafts-heading">
          <h3 id="expense-drafts-heading">Private review-ready drafts</h3>
          <div class="draft-list">
            ${state.expenses.length === 0
              ? html`<p class="subtitle">No expense drafts.</p>`
              : state.expenses.map((draft) => html`
                  <article class="draft">
                    <strong>${draft.merchant} · ${draft.currency} ${draft.amount.toFixed(2)}</strong>
                    ${draft.category}. ${draft.note}
                    <div class="source">not submitted · user must submit</div>
                  </article>
                `)}
          </div>
        </section>
      `;
    }
    return html`
      <section class="panel" data-desktop-private aria-labelledby="decision-drafts-heading">
        <h3 id="decision-drafts-heading">Private decision, memo, and meme drafts</h3>
        <div class="draft-list">
          ${[
            ...state.decisions.map((draft) => ({
              title: draft.title,
              body: draft.evidence,
              kind: 'decision draft',
            })),
            ...state.memos.map((draft) => ({
              title: draft.title,
              body: draft.body,
              kind: 'private memo draft',
            })),
            ...state.memes.map((draft) => ({
              title: draft.caption,
              body: draft.altText,
              kind: 'private meme draft with alt text',
            })),
          ].map((draft) => html`
            <article class="draft">
              <strong>${draft.title}</strong>
              ${draft.body}
              <div class="source">${draft.kind} · never auto-sent</div>
            </article>
          `)}
        </div>
      </section>
    `;
  }

  private renderDocumentationActions() {
    if (this.appId !== 'documentation') return nothing;
    return html`
      <section class="panel">
        <h3>Copy-ready local helpers</h3>
        <p class="subtitle">
          Copying is local. These controls never invoke a publish endpoint.
        </p>
        <div class="actions" style="margin-top:.65rem">
          <button @click=${() => void this.copy(
            'Code',
            'npm test --prefix typescript/ui',
          )}>Copy code</button>
          <button @click=${() => void this.copy(
            'Prompt',
            'Review the redacted evidence ledger and draft a truthful docs update. Do not publish.',
          )}>Copy prompt</button>
        </div>
        ${this.copied
          ? html`<p class="subtitle" role="status" aria-live="polite">${this.copied}</p>`
          : nothing}
      </section>
    `;
  }

  render() {
    if (!isCompanyAppId(this.appId)) {
      return html`<div class="error" role="alert">Unknown Living Company app.</div>`;
    }
    const registration = companyAppRegistration(this.appId);
    if (this.loading) {
      return html`<div class="empty" role="status">Loading ${registration.title}…</div>`;
    }
    if (this.error || !this.snapshot) {
      return html`<div class="error" role="alert">${this.error || 'No company data returned.'}</div>`;
    }
    return html`
      <header>
        <div>
          <h2>${registration.title}</h2>
          <p class="subtitle">${registration.description}</p>
        </div>
        <span class="status ${this.snapshot.status}" role="status">
          ${this.snapshot.status}
        </span>
      </header>
      <div class="body">
        <section class="facts" aria-label="${registration.title} facts">
          ${this.snapshot.facts.length === 0
            ? html`<div class="fact"><span class="label">No verified facts available.</span></div>`
            : this.snapshot.facts.map((fact) => html`
                <article class="fact">
                  <span class="label">${fact.label}</span>
                  <strong>${fact.value}</strong>
                  <div class="source">source: ${fact.source}</div>
                </article>
              `)}
        </section>

        ${this.snapshot.unavailable.length > 0
          ? html`
              <section class="panel unavailable" role="status">
                <h3>Truthful limits</h3>
                ${this.snapshot.unavailable.map((reason) => html`<p>${reason}</p>`)}
              </section>
            `
          : nothing}

        <section class="panel">
          <h3>Registered data seams</h3>
          <div class="seams">
            ${this.snapshot.dataSeams.map((seam) => html`<code>${seam}</code>`)}
          </div>
        </section>

        ${this.relatedActions().length > 0
          ? html`
              <section class="panel">
                <h3>Bounded work surfaces</h3>
                <div class="actions">
                  ${this.relatedActions().map(([label, appId]) => html`
                    <button @click=${() => this.openApp(appId)}>Open ${label}</button>
                  `)}
                </div>
              </section>
            `
          : nothing}

        ${this.renderDocumentationActions()}
        ${this.renderScenario()}
        ${this.renderPrivateDrafts()}
      </div>
    `;
  }
}

export { COMPANY_APP_IDS };

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-company-app': OpenRappterCompanyApp;
  }
}
