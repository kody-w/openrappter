import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { gateway } from '../services/gateway.js';

interface ScenarioInfo {
  name: string;
  profile: string;
  kind: string;
  physical: boolean;
  expected: {
    ok: boolean;
    step: string | null;
    reason_contains: string | null;
  };
}

interface CardFrame {
  kind: string;
  stream_id: string;
  payload_hash: string;
  payload: {
    profile: string;
    rappid: string;
    classification: string;
    key_id: string;
    endpoint_origin: string;
    requested_scope: string[];
    inventory: Array<{
      part: string;
      space: string;
      hash: string;
      bytes: number;
      required: boolean;
    }>;
  };
}

interface Verification {
  ok: boolean;
  step: string | null;
  reason: string;
  result: {
    status: string;
    runtime_policy_seq: number;
    authority_seq: number;
    revocation_seq: number;
  } | null;
}

interface CardRun {
  scenario: string;
  exact_link: string;
  qr_svg: string;
  frame: CardFrame;
  expected: ScenarioInfo['expected'];
  verification?: Verification;
  provenance: string;
}

interface ProductionStatus {
  available: false;
  status: 'unavailable';
  reason: 'live-adapter-required';
  required_adapters: string[];
}

@customElement('openrappter-rappid-card')
export class OpenRappterRappidCard extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--text-primary);
      background:
        radial-gradient(circle at 16% 4%, rgba(88, 245, 210, 0.12), transparent 28rem),
        radial-gradient(circle at 86% 18%, rgba(124, 92, 255, 0.12), transparent 26rem),
        var(--bg-primary);
    }
    .shell { max-width: 1180px; margin: 0 auto; padding: 2rem; }
    .hero, .panel {
      border: 1px solid var(--border);
      border-radius: 1rem;
      background: color-mix(in srgb, var(--bg-secondary) 94%, transparent);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.14);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.6fr);
      gap: 1rem;
      padding: 1.5rem;
    }
    .eyebrow {
      color: var(--accent);
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }
    h2 { margin: 0.35rem 0 0.55rem; font-size: clamp(1.8rem, 4vw, 3rem); }
    h3, h4 { margin: 0; }
    h4 { margin-top: 1rem; }
    p { color: var(--text-secondary); line-height: 1.55; }
    label { display: block; margin-bottom: 0.45rem; color: var(--text-secondary); }
    select {
      width: 100%;
      padding: 0.72rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-primary);
      background: var(--bg-tertiary);
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 0.65fr) minmax(0, 1.35fr);
      gap: 1rem;
      margin-top: 1rem;
    }
    .panel { padding: 1.2rem; }
    .qr { display: grid; place-items: center; min-height: 280px; background: #fff; border-radius: 0.8rem; }
    .qr img { width: min(100%, 300px); }
    code, .hash { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .link, .fact, .part, .step {
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      background: var(--bg-tertiary);
    }
    .link { margin-top: 0.8rem; color: var(--text-secondary); font-size: 0.68rem; }
    .status-row { display: flex; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .badge {
      padding: 0.28rem 0.6rem;
      border-radius: 999px;
      background: rgba(245, 158, 11, 0.18);
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
    }
    .badge.awake { color: #cffff4; background: rgba(88, 245, 210, 0.16); }
    .badge.failed { color: #fecaca; background: rgba(248, 113, 113, 0.16); }
    .error { margin: 1rem 0; padding: 0.8rem; color: #fecaca; border: 1px solid #7f1d1d; border-radius: 0.7rem; }
    .facts, .parts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.65rem; }
    .parts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .fact span, .part small, .step small { color: var(--text-secondary); font-size: 0.68rem; }
    .fact strong, .part strong { display: block; margin-top: 0.2rem; }
    .actions { display: flex; gap: 0.6rem; margin-top: 1rem; }
    button {
      padding: 0.65rem 0.9rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      cursor: pointer;
      font-weight: 800;
    }
    button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-foreground); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .steps { display: grid; gap: 0.4rem; margin-top: 0.7rem; }
    @media (max-width: 840px) {
      .hero, .grid, .facts, .parts { grid-template-columns: 1fr; }
    }
  `;

  @state() private scenarios: ScenarioInfo[] = [];
  @state() private selected = 'valid-test';
  @state() private run: CardRun | null = null;
  @state() private loading = true;
  @state() private verifying = false;
  @state() private error: string | null = null;
  @state() private productionStatus: ProductionStatus | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.productionStatus = await gateway.call<ProductionStatus>(
        'rappid.card.production-status',
      );
      this.scenarios = await gateway.call<ScenarioInfo[]>('rappid.card.scenarios');
      await this.preview();
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private async choose(event: Event): Promise<void> {
    this.selected = (event.target as HTMLSelectElement).value;
    await this.preview();
  }

  private async preview(): Promise<void> {
    this.error = null;
    this.run = await gateway.call<CardRun>('rappid.card.preview', {
      scenario: this.selected,
    });
  }

  private async verify(): Promise<void> {
    this.verifying = true;
    this.error = null;
    try {
      this.run = await gateway.call<CardRun>('rappid.card.verify', {
        scenario: this.selected,
        approve: true,
      });
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.verifying = false;
    }
  }

  private qrSource(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  render() {
    const verification = this.run?.verification;
    const state = verification ? (verification.ok ? 'awake' : 'failed') : 'preview';
    return html`
      <div class="shell">
        <section class="hero">
          <div>
            <div class="eyebrow">RAPP/1 PR9 · test vectors only</div>
            <h2>RAPPID Debug Card</h2>
            <p>
              Exact eleven-key <code>body.debug-card</code> /
              <code>body.calling-card</code> verification against the vendored
              <code>rapp-1</code> commit <code>4751cd8</code> deck.
            </p>
          </div>
          <div>
            <label for="scenario">Mandatory scenario</label>
            <select id="scenario" .value=${this.selected} @change=${this.choose}>
              ${this.scenarios.map((scenario) => html`
                <option value=${scenario.name}>${scenario.name}</option>
              `)}
            </select>
            <p>
              Expected: ${this.run?.expected.ok ? 'awake' : `refuse at ${this.run?.expected.step}`}
            </p>
          </div>
        </section>
        ${this.productionStatus
          ? html`<div class="error">
              <strong>Production verification unavailable</strong><br />
              Live trusted-clock, connection, fetch, hydration, and continuity
              adapters are required. This Habitat runs fixtures only.
            </div>`
          : nothing}
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        <div class="grid">
          <section class="panel">
            <div class="qr">
              ${this.run
                ? html`<img src=${this.qrSource(this.run.qr_svg)} alt="Scannable PR9 compact RAPPID URI" />`
                : nothing}
            </div>
            ${this.run ? html`<div class="link"><code>${this.run.exact_link}</code></div>` : nothing}
          </section>
          <section class="panel">
            <div class="status-row">
              <div><div class="eyebrow">Ordered verifier</div><h3>${state}</h3></div>
              <span class="badge ${state}">${state}</span>
            </div>
            ${verification && !verification.ok
              ? html`<div class="error"><strong>${verification.step}</strong><br />${verification.reason}</div>`
              : nothing}
            ${this.run ? html`
              <div class="facts">
                <div class="fact"><span>Kind</span><strong>${this.run.frame.kind}</strong></div>
                <div class="fact"><span>Profile</span><strong>${this.run.frame.payload.profile}</strong></div>
                <div class="fact"><span>Classification</span><strong>${this.run.frame.payload.classification}</strong></div>
                <div class="fact"><span>Keyed issuer</span><strong class="hash">${this.run.frame.payload.key_id}</strong></div>
                <div class="fact"><span>Endpoint origin</span><strong>${this.run.frame.payload.endpoint_origin}</strong></div>
                <div class="fact"><span>Particle</span><strong class="hash">${this.run.frame.payload_hash}</strong></div>
              </div>
              <h4>Signed inventory</h4>
              <div class="parts">
                ${this.run.frame.payload.inventory.map((part) => html`
                  <div class="part">
                    <strong>${part.part}</strong>
                    <small>${part.space} · ${part.bytes} B · required=${String(part.required)}</small><br />
                    <small class="hash">${part.hash}</small>
                  </div>
                `)}
              </div>
              <div class="actions">
                <button @click=${() => void this.preview()} ?disabled=${this.loading || this.verifying}>Reset preview</button>
                <button class="primary" @click=${() => void this.verify()} ?disabled=${this.verifying}>
                  ${this.verifying ? 'Verifying…' : 'Explicitly run verifier'}
                </button>
              </div>
              <h4>PR9 order</h4>
              <div class="steps">
                ${['parse','content-address','schema','signature','expiry','revocation','compatibility','classification-scope','replay-nonce','hydration','continuity'].map(
                  (step, index) => html`<div class="step"><small>${index + 1}</small> ${step}</div>`,
                )}
              </div>
            ` : nothing}
          </section>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-rappid-card': OpenRappterRappidCard;
  }
}
