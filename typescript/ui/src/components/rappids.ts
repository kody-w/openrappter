/**
 * Quantum RAPPID Habitat
 *
 * One canonical identity rendered across append-only dimensions. Creature-card
 * stats are derived from verified frames and content-addressed assets.
 */

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';

interface RappidDimension {
  name: string;
  status: 'active' | 'linked' | 'missing';
  mediaTypes?: string[];
}

interface RappidStats {
  frameHeight: number;
  displayHeightMm: number;
  totalWeightBytes: number | null;
  verifiedWeightBytes: number;
  residentWeightBytes: number | null;
  linkedWeightBytes: number | null;
  weightComplete: boolean;
  uniqueFrames: number;
  uniqueAssets: number;
}

interface QuantumRappidSummary {
  rappid: string;
  name: string;
  displayName: string;
  species: string;
  lifecycleStage: 'baby' | 'hatchling' | 'raptor';
  localOnly: boolean;
  stats: RappidStats;
  traits: Record<string, number>;
  dimensions: RappidDimension[];
  sonic?: {
    wakeCall: boolean;
    midiDna: boolean;
    autocomplete: boolean;
  };
}

interface GrowthProposal {
  id: string;
  rappid: string;
  dimension: string;
  title: string;
  summary: string;
  predictedStats: RappidStats;
  evidence: string[];
  authoritative: false;
  appendable: boolean;
}

interface AssetPayload {
  mediaType: string;
  base64: string;
  sha256: string;
}

type AutonomyLeash = 'observe' | 'propose' | 'approved';

@customElement('openrappter-rappids')
export class OpenRappterRappids extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--text-primary);
      background:
        radial-gradient(circle at 18% 8%, rgba(88, 245, 210, 0.1), transparent 28rem),
        radial-gradient(circle at 88% 22%, rgba(124, 92, 255, 0.1), transparent 24rem),
        var(--bg-primary);
    }

    .shell {
      max-width: 1180px;
      margin: 0 auto;
      padding: 2rem;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.7fr);
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .hero-copy,
    .leash,
    .panel {
      border: 1px solid var(--border);
      border-radius: 1rem;
      background: color-mix(in srgb, var(--bg-secondary) 92%, transparent);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.14);
    }

    .hero-copy {
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
      margin: 0.35rem 0 0.5rem;
      font-size: clamp(1.8rem, 4vw, 3rem);
      letter-spacing: -0.045em;
    }

    .hero-copy p,
    .muted {
      color: var(--text-secondary);
      line-height: 1.55;
    }

    .leash {
      padding: 1.25rem;
    }

    .leash label {
      display: block;
      margin-bottom: 0.45rem;
      font-size: 0.76rem;
      font-weight: 700;
      color: var(--text-secondary);
    }

    select {
      width: 100%;
      padding: 0.68rem 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.65rem;
      color: var(--text-primary);
      background: var(--bg-tertiary);
      font: inherit;
    }

    .leash small {
      display: block;
      margin-top: 0.65rem;
      color: var(--text-secondary);
      line-height: 1.45;
    }

    .organism-grid {
      display: grid;
      grid-template-columns: minmax(280px, 0.8fr) minmax(0, 1.45fr);
      gap: 1.25rem;
    }

    .panel {
      padding: 1.25rem;
    }

    .collection {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
      margin-top: 1rem;
    }

    .organism-button {
      display: grid;
      grid-template-columns: 46px minmax(0, 1fr) auto;
      gap: 0.7rem;
      align-items: center;
      width: 100%;
      padding: 0.7rem;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
    }

    .organism-button.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px var(--accent);
    }

    .mini-creature {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background:
        radial-gradient(circle at 36% 28%, #dcfff7 0 8%, #58f5d2 9% 28%, #352969 70%);
      box-shadow: 0 0 20px rgba(88, 245, 210, 0.25);
      font-size: 1.2rem;
    }

    .organism-name {
      font-weight: 800;
    }

    .organism-species {
      display: block;
      margin-top: 0.15rem;
      color: var(--text-secondary);
      font-size: 0.72rem;
    }

    .stage {
      padding: 0.2rem 0.48rem;
      border-radius: 999px;
      color: #d9fff6;
      background: rgba(88, 245, 210, 0.12);
      font-size: 0.65rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .identity {
      display: grid;
      grid-template-columns: 210px minmax(0, 1fr);
      gap: 1.2rem;
      align-items: center;
    }

    .field {
      position: relative;
      display: grid;
      place-items: center;
      min-height: 210px;
      overflow: hidden;
      border: 1px solid rgba(88, 245, 210, 0.22);
      border-radius: 1rem;
      background:
        radial-gradient(circle, rgba(88, 245, 210, 0.18), transparent 42%),
        repeating-radial-gradient(circle, transparent 0 22px, rgba(124, 92, 255, 0.1) 23px 24px);
    }

    .field::before,
    .field::after {
      content: '';
      position: absolute;
      width: 128px;
      height: 128px;
      border: 1px solid rgba(88, 245, 210, 0.3);
      border-radius: 50%;
      transform: rotateX(64deg) rotateZ(18deg);
    }

    .field::after {
      width: 174px;
      height: 174px;
      border-color: rgba(124, 92, 255, 0.25);
      transform: rotateX(68deg) rotateZ(-26deg);
    }

    .creature {
      position: relative;
      z-index: 1;
      font-size: 5.4rem;
      filter: drop-shadow(0 0 22px rgba(88, 245, 210, 0.34));
      animation: breathe 3.4s ease-in-out infinite;
    }

    @keyframes breathe {
      0%, 100% { transform: translateY(2px) scale(0.98); }
      50% { transform: translateY(-5px) scale(1.02); }
    }

    .identity h3 {
      margin: 0;
      font-size: 1.7rem;
    }

    .rappid-id {
      margin: 0.45rem 0 0.8rem;
      overflow-wrap: anywhere;
      color: var(--text-secondary);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.69rem;
    }

    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.65rem;
      margin-top: 1.1rem;
    }

    .stat {
      padding: 0.85rem;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      background: var(--bg-tertiary);
    }

    .stat strong {
      display: block;
      font-size: 1.2rem;
    }

    .stat span {
      display: block;
      margin-top: 0.16rem;
      color: var(--text-secondary);
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .incomplete {
      color: #fbbf24;
      font-size: 0.7rem;
    }

    .lower-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }

    .subpanel {
      padding: 1rem;
      border: 1px solid var(--border);
      border-radius: 0.8rem;
      background: var(--bg-tertiary);
    }

    .subpanel h4 {
      margin: 0 0 0.75rem;
    }

    .trait {
      display: grid;
      grid-template-columns: 7rem minmax(0, 1fr) 2.5rem;
      gap: 0.55rem;
      align-items: center;
      margin: 0.48rem 0;
      font-size: 0.72rem;
    }

    .trait-track {
      height: 6px;
      overflow: hidden;
      border-radius: 99px;
      background: var(--bg-primary);
    }

    .trait-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #58f5d2, #7c5cff);
    }

    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .chip {
      padding: 0.28rem 0.55rem;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--text-secondary);
      font-size: 0.7rem;
    }

    .chip.active {
      border-color: rgba(88, 245, 210, 0.35);
      color: #bfffee;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.55rem;
      margin-top: 0.85rem;
    }

    button.action {
      padding: 0.58rem 0.8rem;
      border: 1px solid var(--border);
      border-radius: 0.6rem;
      background: var(--bg-secondary);
      color: var(--text-primary);
      cursor: pointer;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 700;
    }

    button.action.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: var(--accent-foreground);
    }

    button.action:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .proposal {
      margin-top: 0.85rem;
      padding: 0.85rem;
      border: 1px solid rgba(124, 92, 255, 0.35);
      border-radius: 0.75rem;
      background: rgba(124, 92, 255, 0.08);
    }

    .proposal strong {
      display: block;
      margin-bottom: 0.3rem;
    }

    .proposal ul {
      margin: 0.55rem 0;
      padding-left: 1.1rem;
      color: var(--text-secondary);
      font-size: 0.74rem;
    }

    .notice,
    .error {
      margin: 1rem 0 0;
      padding: 0.75rem;
      border-radius: 0.65rem;
      font-size: 0.78rem;
    }

    .notice {
      border: 1px solid rgba(88, 245, 210, 0.25);
      background: rgba(88, 245, 210, 0.06);
      color: #cffff4;
    }

    .error {
      border: 1px solid rgba(248, 113, 113, 0.35);
      background: rgba(248, 113, 113, 0.08);
      color: #fecaca;
    }

    @media (max-width: 840px) {
      .hero,
      .organism-grid,
      .identity,
      .lower-grid {
        grid-template-columns: 1fr;
      }

      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .creature {
        animation: none;
      }
    }
  `;

  @state() private organisms: QuantumRappidSummary[] = [];
  @state() private selectedId: string | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private proposal: GrowthProposal | null = null;
  @state() private proposing = false;
  @state() private growing = false;
  @state() private wakePlaying = false;
  @state() private autonomyLeash: AutonomyLeash = 'propose';
  private activeAudio?: HTMLAudioElement;
  private activeAudioUrl?: string;

  connectedCallback(): void {
    super.connectedCallback();
    void this.loadOrganisms();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.activeAudio?.pause();
    this.wakePlaying = false;
    if (this.activeAudioUrl) URL.revokeObjectURL(this.activeAudioUrl);
  }

  private get selected(): QuantumRappidSummary | undefined {
    return this.organisms.find((item) => item.rappid === this.selectedId)
      ?? this.organisms[0];
  }

  private async loadOrganisms(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.organisms = await gateway.call<QuantumRappidSummary[]>('rappid.list');
      if (!this.selectedId && this.organisms.length) {
        this.selectedId = this.organisms[0].rappid;
      }
    } catch (error) {
      this.error = (error as Error).message;
      this.organisms = [];
    } finally {
      this.loading = false;
    }
  }

  private selectOrganism(rappid: string): void {
    this.selectedId = rappid;
    this.proposal = null;
  }

  private formatBytes(bytes: number | null): string {
    if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) {
      return 'Unverified';
    }
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  private formatHeight(mm: number): string {
    if (!Number.isSafeInteger(mm) || mm < 0) return 'Unverified';
    return `${(mm / 1000).toFixed(2)} m`;
  }

  private async playWakeCall(): Promise<void> {
    const selected = this.selected;
    if (!selected?.sonic?.wakeCall) return;
    if (this.activeAudio && !this.activeAudio.paused) {
      this.activeAudio.pause();
      this.activeAudio.currentTime = 0;
      this.wakePlaying = false;
      return;
    }
    this.error = null;
    try {
      let asset: AssetPayload;
      try {
        asset = await gateway.call<AssetPayload>('rappid.asset', {
          rappid: selected.rappid,
          asset: 'wake-call',
        });
      } catch (preferredError) {
        try {
          asset = await gateway.call<AssetPayload>('rappid.asset', {
            rappid: selected.rappid,
            asset: 'wake-call-lossless',
          });
        } catch (fallbackError) {
          throw new Error(
            `preferred track failed: ${(preferredError as Error).message}; `
              + `lossless fallback failed: ${(fallbackError as Error).message}`,
          );
        }
      }
      const raw = atob(asset.base64);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: asset.mediaType }));
      this.activeAudio?.pause();
      if (this.activeAudioUrl) URL.revokeObjectURL(this.activeAudioUrl);
      const audio = new Audio(url);
      this.activeAudio = audio;
      this.activeAudioUrl = url;
      this.wakePlaying = true;
      audio.addEventListener('ended', () => {
        URL.revokeObjectURL(url);
        if (this.activeAudio === audio) this.activeAudio = undefined;
        if (this.activeAudioUrl === url) this.activeAudioUrl = undefined;
        this.wakePlaying = false;
      }, { once: true });
      await audio.play();
    } catch (error) {
      this.wakePlaying = false;
      this.error = `Wake call failed: ${(error as Error).message}`;
    }
  }

  private async previewGrowth(dimension = 'stats'): Promise<void> {
    const selected = this.selected;
    if (!selected || this.autonomyLeash === 'observe') return;
    this.proposing = true;
    this.error = null;
    try {
      this.proposal = await gateway.call<GrowthProposal>('rappid.autocomplete', {
        rappid: selected.rappid,
        dimension,
      });
    } catch (error) {
      this.error = `Autocomplete failed: ${(error as Error).message}`;
    } finally {
      this.proposing = false;
    }
  }

  private async appendGrowth(): Promise<void> {
    if (
      !this.proposal
      || this.autonomyLeash !== 'approved'
      || this.proposal.authoritative !== false
    ) {
      return;
    }
    this.growing = true;
    this.error = null;
    try {
      await gateway.call('rappid.grow', {
        rappid: this.proposal.rappid,
        proposalId: this.proposal.id,
      });
      this.proposal = null;
      await this.loadOrganisms();
    } catch (error) {
      this.error = `Growth append failed: ${(error as Error).message}`;
    } finally {
      this.growing = false;
    }
  }

  private renderCollection(): unknown {
    return html`
      <section class="panel">
        <div class="eyebrow">Field guide</div>
        <div class="collection">
          ${this.organisms.map((organism) => html`
            <button
              class="organism-button ${organism.rappid === this.selected?.rappid ? 'active' : ''}"
              @click=${() => this.selectOrganism(organism.rappid)}
            >
              <span class="mini-creature" aria-hidden="true">✦</span>
              <span>
                <span class="organism-name">${organism.displayName}</span>
                <span class="organism-species">${organism.species}</span>
              </span>
              <span class="stage">${organism.lifecycleStage}</span>
            </button>
          `)}
        </div>
      </section>
    `;
  }

  private renderSelected(organism: QuantumRappidSummary): unknown {
    const stats = organism.stats;
    return html`
      <section class="panel">
        <div class="identity">
          <div class="field" aria-label="${organism.displayName}, ${organism.lifecycleStage} stage">
            <span class="creature" aria-hidden="true">🦖</span>
          </div>
          <div>
            <div class="eyebrow">${organism.species}</div>
            <h3>${organism.displayName}</h3>
            <div class="rappid-id">${organism.rappid}</div>
            <span class="stage">${organism.lifecycleStage} stage</span>
            ${organism.localOnly
              ? html`<div class="notice">Local habitat · private engrams stay on this device.</div>`
              : nothing}
          </div>
        </div>

        <div class="stats">
          <div class="stat">
            <strong>${this.formatBytes(
              stats.weightComplete
                ? stats.totalWeightBytes
                : stats.verifiedWeightBytes,
            )}</strong>
            <span>Weight</span>
            ${stats.weightComplete
              ? nothing
              : html`<small class="incomplete">verified · total incomplete</small>`}
          </div>
          <div class="stat">
            <strong>${stats.frameHeight} frames</strong>
            <span>Frame height</span>
          </div>
          <div class="stat">
            <strong>${this.formatHeight(stats.displayHeightMm)}</strong>
            <span>Species height</span>
          </div>
          <div class="stat">
            <strong>${organism.dimensions.length}</strong>
            <span>Dimensions</span>
          </div>
        </div>

        <div class="lower-grid">
          <div class="subpanel">
            <h4>Traits</h4>
            ${Object.entries(organism.traits).map(([name, value]) => html`
              <div class="trait">
                <span>${name.replaceAll('_', ' ')}</span>
                <span class="trait-track">
                  <span class="trait-fill" style="width:${Math.round(value * 100)}%"></span>
                </span>
                <span>${Math.round(value * 100)}</span>
              </div>
            `)}
          </div>
          <div class="subpanel">
            <h4>Dimensional body</h4>
            <div class="chips">
              ${organism.dimensions.map((dimension) => html`
                <span class="chip ${dimension.status}">
                  ${dimension.name} · ${dimension.status}
                </span>
              `)}
            </div>
            <div class="actions">
              <button
                class="action"
                ?disabled=${!organism.sonic?.wakeCall}
                @click=${this.playWakeCall}
                aria-label=${this.wakePlaying
                  ? `Stop ${organism.displayName}'s wake call`
                  : `Play ${organism.displayName}'s original wake call`}
              >${this.wakePlaying ? '■ Stop wake call' : '▶ Wake call'}</button>
              <button
                class="action"
                ?disabled=${!organism.sonic?.autocomplete || this.autonomyLeash === 'observe'}
                @click=${() => this.previewGrowth('sonic')}
              >♫ Continue MIDI</button>
              <button
                class="action primary"
                ?disabled=${this.proposing || this.autonomyLeash === 'observe'}
                @click=${() => this.previewGrowth('stats')}
              >${this.proposing ? 'Imagining…' : 'Preview next frame'}</button>
            </div>
            <p class="muted">
              Resident ${this.formatBytes(stats.residentWeightBytes)} ·
              linked ${this.formatBytes(stats.linkedWeightBytes)} ·
              ${stats.uniqueFrames} unique frames · ${stats.uniqueAssets} unique assets
            </p>
          </div>
        </div>

        ${this.proposal ? html`
          <div class="proposal">
            <div class="eyebrow">Non-authoritative autocomplete</div>
            <strong>${this.proposal.title}</strong>
            <div>${this.proposal.summary}</div>
            <ul>
              ${this.proposal.evidence.map((item) => html`<li>${item}</li>`)}
            </ul>
            <div class="actions">
              <button class="action" @click=${() => (this.proposal = null)}>Discard</button>
              <button
                class="action primary"
                ?disabled=${!this.proposal.appendable
                  || this.autonomyLeash !== 'approved'
                  || this.growing}
                @click=${this.appendGrowth}
              >${this.growing ? 'Appending…' : 'Append verified growth frame'}</button>
            </div>
          </div>
        ` : nothing}
      </section>
    `;
  }

  render(): unknown {
    const selected = this.selected;
    return html`
      <main class="shell">
        <section class="hero">
          <div class="hero-copy">
            <div class="eyebrow">Quantum RAPPID Habitat</div>
            <h2>One identity. Many dimensions.</h2>
            <p>
              Every verified memory, skill, sound, device, and capability adds
              an append-only body frame. Weight is unique verified bytes. Height
              is verified frame depth. Nothing speculative becomes part of the
              organism until a new frame passes.
            </p>
          </div>
          <div class="leash">
            <label for="autonomy-leash">Self-steer leash</label>
            <select
              id="autonomy-leash"
              .value=${this.autonomyLeash}
              @change=${(event: Event) => {
                this.autonomyLeash =
                  (event.target as HTMLSelectElement).value as AutonomyLeash;
              }}
            >
              <option value="observe">Observe only</option>
              <option value="propose">Propose growth</option>
              <option value="approved">Run approved appends</option>
            </select>
            <small>
              Autocomplete may imagine the next dimension. Only an approved,
              verified append changes the living organism.
            </small>
          </div>
        </section>

        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${this.loading
          ? html`<div class="panel">Locating local RAPPIDs…</div>`
          : this.organisms.length === 0
            ? html`<div class="panel">No conformant Quantum RAPPIDs found.</div>`
            : html`
                <div class="organism-grid">
                  ${this.renderCollection()}
                  ${selected ? this.renderSelected(selected) : nothing}
                </div>
              `}
      </main>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-rappids': OpenRappterRappids;
  }
}
