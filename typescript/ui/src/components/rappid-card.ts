/**
 * Virtual RAPPID Debug Card Habitat
 *
 * The browser never receives fixture keys or content-provider authority. It
 * selects a server-owned deterministic fixture, previews the verified card,
 * and sends a separate explicit approval before hydration can begin.
 */

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import { gateway } from '../services/gateway.js';

interface FixtureInfo {
  name: string;
  label: string;
  description: string;
  transport: 'virtual' | 'physical-reproduction';
  expectedState: string;
  expectedError: string | null;
}

interface CardSnapshot {
  state: string;
  outcome: 'pending' | 'awake' | 'failed';
  error: { code: string; message: string } | null;
  preview: {
    rappid: string;
    profile: string;
    endpoint: string;
    issuerKeyId: string;
    classification: string;
    scopes: string[];
    parts: Array<{
      name: string;
      hash: string;
      bytes: number;
      mediaType: string;
      required: boolean;
    }>;
  } | null;
  hydrated: Array<{
    name: string;
    hash: string;
    bytes: number;
    mediaType: string;
  }>;
  audit: Array<{
    seq: number;
    state: string;
    event: string;
    detail: string;
  }>;
}

interface CardRun {
  fixture: string;
  exactDeepLink: string;
  qrSvg: string;
  simulation: CardSnapshot;
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

    .shell {
      max-width: 1180px;
      margin: 0 auto;
      padding: 2rem;
    }

    .hero,
    .panel {
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

    h2 {
      margin: 0.35rem 0 0.55rem;
      font-size: clamp(1.8rem, 4vw, 3rem);
      letter-spacing: -0.045em;
    }

    p {
      color: var(--text-secondary);
      line-height: 1.55;
    }

    label {
      display: block;
      margin-bottom: 0.45rem;
      color: var(--text-secondary);
      font-size: 0.75rem;
      font-weight: 700;
    }

    select {
      width: 100%;
      padding: 0.72rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      font: inherit;
    }

    .fixture-copy {
      min-height: 3.2rem;
      margin: 0.65rem 0 0;
      font-size: 0.76rem;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(260px, 0.65fr) minmax(0, 1.35fr);
      gap: 1rem;
      margin-top: 1rem;
    }

    .panel {
      padding: 1.2rem;
    }

    .qr {
      display: grid;
      place-items: center;
      min-height: 280px;
      padding: 1rem;
      border-radius: 0.8rem;
      background: #fff;
    }

    .qr img {
      display: block;
      width: min(100%, 300px);
      height: auto;
    }

    code,
    .hash {
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .link {
      margin: 0.8rem 0 0;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-secondary);
      background: var(--bg-tertiary);
      font-size: 0.68rem;
    }

    .status-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1rem;
    }

    .badge {
      padding: 0.28rem 0.6rem;
      border-radius: 999px;
      color: #fef3c7;
      background: rgba(245, 158, 11, 0.18);
      font-size: 0.72rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .badge.awake {
      color: #cffff4;
      background: rgba(88, 245, 210, 0.16);
    }

    .badge.failed {
      color: #fecaca;
      background: rgba(248, 113, 113, 0.16);
    }

    .error {
      margin-bottom: 1rem;
      padding: 0.8rem;
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 0.7rem;
      color: #fecaca;
      background: rgba(248, 113, 113, 0.08);
    }

    .facts,
    .parts {
      display: grid;
      gap: 0.65rem;
    }

    .facts {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .fact,
    .part,
    .audit-event {
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.7rem;
      background: var(--bg-tertiary);
    }

    .fact strong {
      display: block;
      margin-top: 0.2rem;
      font-size: 0.85rem;
    }

    .fact span,
    .part small,
    .audit-event small {
      color: var(--text-secondary);
      font-size: 0.67rem;
    }

    h3,
    h4 {
      margin: 0;
    }

    h4 {
      margin: 1rem 0 0.6rem;
    }

    .parts {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .part strong {
      display: block;
      margin-bottom: 0.25rem;
    }

    .actions {
      display: flex;
      gap: 0.6rem;
      margin-top: 1rem;
    }

    button {
      padding: 0.65rem 0.9rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      cursor: pointer;
      font: inherit;
      font-size: 0.78rem;
      font-weight: 800;
    }

    button.primary {
      border-color: var(--accent);
      color: var(--accent-foreground);
      background: var(--accent);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .audit {
      display: grid;
      gap: 0.45rem;
      margin-top: 0.7rem;
    }

    .audit-event {
      display: grid;
      grid-template-columns: 2rem 7.5rem minmax(0, 1fr);
      gap: 0.6rem;
      align-items: baseline;
      font-size: 0.72rem;
    }

    .empty {
      color: var(--text-secondary);
    }

    @media (max-width: 840px) {
      .hero,
      .grid,
      .facts,
      .parts {
        grid-template-columns: 1fr;
      }
    }
  `;

  @state() private fixtures: FixtureInfo[] = [];
  @state() private selected = 'valid';
  @state() private run: CardRun | null = null;
  @state() private loading = true;
  @state() private approving = false;
  @state() private error: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadFixtures();
  }

  private get selectedFixture(): FixtureInfo | undefined {
    return this.fixtures.find((fixture) => fixture.name === this.selected);
  }

  private async loadFixtures(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.fixtures = await gateway.call<FixtureInfo[]>('rappid.card.fixtures');
      if (this.fixtures.length && !this.fixtures.some((item) => item.name === this.selected)) {
        this.selected = this.fixtures[0].name;
      }
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
    this.run = null;
    try {
      this.run = await gateway.call<CardRun>('rappid.card.preview', {
        fixture: this.selected,
      });
    } catch (error) {
      this.error = (error as Error).message;
    }
  }

  private async approve(): Promise<void> {
    this.approving = true;
    this.error = null;
    try {
      this.run = await gateway.call<CardRun>('rappid.card.simulate', {
        fixture: this.selected,
        approve: true,
      });
    } catch (error) {
      this.error = (error as Error).message;
    } finally {
      this.approving = false;
    }
  }

  private qrSource(svg: string): string {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  render() {
    const snapshot = this.run?.simulation;
    const badgeClass =
      snapshot?.state === 'awake'
        ? 'awake'
        : snapshot?.state === 'failed'
          ? 'failed'
          : '';
    const canApprove =
      snapshot?.state === 'preview'
      && !this.approving;
    return html`
      <div class="shell">
        <section class="hero">
          <div>
            <div class="eyebrow">Developer habitat · synthetic fixtures only</div>
            <h2>Virtual RAPPID Debug Card</h2>
            <p>
              Parse → verify → preview → explicit approve → content-addressed
              hydration → continuity challenge → awake. No real network,
              credential lookup, executable payload, or private memory is used.
            </p>
          </div>
          <div>
            <label for="fixture">Deterministic fixture</label>
            <select id="fixture" .value=${this.selected} @change=${this.choose}>
              ${this.fixtures.map((fixture) => html`
                <option value=${fixture.name}>${fixture.label}</option>
              `)}
            </select>
            <p class="fixture-copy">
              ${this.selectedFixture?.description ?? 'Loading fixture deck…'}
            </p>
          </div>
        </section>

        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

        <div class="grid">
          <section class="panel">
            <div class="qr">
              ${this.run
                ? html`<img
                    src=${this.qrSource(this.run.qrSvg)}
                    alt="Scannable QR code for the exact RAPPID deep link"
                  />`
                : html`<span class="empty">${this.loading ? 'Rendering QR…' : 'No QR'}</span>`}
            </div>
            ${this.run
              ? html`<div class="link"><code>${this.run.exactDeepLink}</code></div>`
              : nothing}
          </section>

          <section class="panel">
            <div class="status-row">
              <div>
                <div class="eyebrow">State machine</div>
                <h3>${snapshot?.state ?? 'loading'}</h3>
              </div>
              <span class="badge ${badgeClass}">${snapshot?.outcome ?? 'pending'}</span>
            </div>

            ${snapshot?.error
              ? html`<div class="error">
                  <strong>${snapshot.error.code}</strong><br />
                  ${snapshot.error.message}
                </div>`
              : nothing}

            ${snapshot?.preview
              ? html`
                  <div class="facts">
                    <div class="fact">
                      <span>Profile</span>
                      <strong>${snapshot.preview.profile}</strong>
                    </div>
                    <div class="fact">
                      <span>Classification</span>
                      <strong>${snapshot.preview.classification}</strong>
                    </div>
                    <div class="fact">
                      <span>Issuer key</span>
                      <strong>${snapshot.preview.issuerKeyId}</strong>
                    </div>
                  </div>
                  <h4>Permitted content-addressed parts</h4>
                  <div class="parts">
                    ${snapshot.preview.parts.map((part) => html`
                      <div class="part">
                        <strong>${part.name}</strong>
                        <small>${part.bytes} B · ${part.mediaType}</small><br />
                        <small class="hash">${part.hash}</small>
                      </div>
                    `)}
                  </div>
                `
              : nothing}

            <div class="actions">
              <button @click=${() => void this.preview()} ?disabled=${this.loading || this.approving}>
                Reset to preview
              </button>
              <button
                class="primary"
                @click=${() => void this.approve()}
                ?disabled=${!canApprove}
              >
                ${this.approving ? 'Hydrating…' : 'Explicitly approve hydration'}
              </button>
            </div>

            <h4>Bounded audit events</h4>
            <div class="audit">
              ${snapshot?.audit.length
                ? snapshot.audit.map((event) => html`
                    <div class="audit-event">
                      <small>#${event.seq}</small>
                      <strong>${event.event}</strong>
                      <span>${event.detail}</span>
                    </div>
                  `)
                : html`<span class="empty">No events yet.</span>`}
            </div>
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
