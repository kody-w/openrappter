import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  RELEASE_RINGS,
  applyReleaseRing,
  loadReleaseRing,
  previewReleaseRing,
  type ReleaseRing,
  type ReleaseRingStatus,
} from '../services/release-rings.js';

@customElement('openrappter-release-ring-switcher')
export class OpenRappterReleaseRingSwitcher extends LitElement {
  static styles = css`
    :host { display: block; margin-bottom: 1rem; }
    .card {
      border: 1px solid var(--border); border-radius: 0.5rem;
      background: var(--bg-secondary); padding: 0.875rem 1rem;
    }
    .row { display: flex; gap: 0.75rem; align-items: end; flex-wrap: wrap; }
    .title { flex: 1; min-width: 220px; }
    h3 { margin: 0; font-size: 0.9rem; }
    p { margin: 0.2rem 0 0; color: var(--text-secondary); font-size: 0.75rem; }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; color: var(--text-secondary); }
    select {
      min-width: 130px; padding: 0.45rem 0.55rem; border: 1px solid var(--border);
      border-radius: 0.375rem; color: var(--text-primary); background: var(--bg-tertiary);
    }
    button {
      padding: 0.5rem 0.85rem; border: 1px solid var(--accent); border-radius: 0.375rem;
      color: white; background: var(--accent); cursor: pointer; font-size: 0.78rem;
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .identity {
      display: grid; grid-template-columns: repeat(4, minmax(0, auto)); gap: 0.35rem 1rem;
      margin-top: 0.75rem; font-size: 0.75rem;
    }
    .identity span { color: var(--text-secondary); }
    code { color: var(--text-primary); overflow-wrap: anywhere; }
    .warning, .error {
      margin-top: 0.65rem; padding: 0.55rem 0.65rem; border-radius: 0.35rem; font-size: 0.75rem;
    }
    .warning { background: rgba(245, 158, 11, 0.15); color: var(--warning, #fbbf24); }
    .error { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }
    .approval { margin-top: 0.55rem; flex-direction: row; align-items: center; gap: 0.4rem; }
    .success { margin-top: 0.55rem; color: #6ee7b7; font-size: 0.75rem; }
    @media (max-width: 720px) {
      .identity { grid-template-columns: 1fr; }
    }
  `;

  @state() private selectedRing: ReleaseRing = 'stable';
  @state() private appliedRing: ReleaseRing = 'stable';
  @state() private currentVersion = '';
  @state() private resolved: ReleaseRingStatus | null = null;
  @state() private loading = true;
  @state() private applying = false;
  @state() private allowDowngrade = false;
  @state() private error: string | null = null;
  @state() private success: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const state = await loadReleaseRing();
      this.selectedRing = state.selectedRing;
      this.appliedRing = state.selectedRing;
      this.currentVersion = state.currentVersion;
      this.resolved = state.resolved;
    } catch (error) {
      this.error = String(error);
    } finally {
      this.loading = false;
    }
  }

  private async choose(event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    if (!RELEASE_RINGS.includes(value as ReleaseRing)) return;
    this.selectedRing = value as ReleaseRing;
    this.allowDowngrade = false;
    this.success = null;
    this.error = null;
    this.loading = true;
    try {
      this.resolved = await previewReleaseRing(this.selectedRing);
    } catch (error) {
      this.resolved = null;
      this.error = String(error);
    } finally {
      this.loading = false;
    }
  }

  private async apply(): Promise<void> {
    if (!this.resolved?.canApply) return;
    this.applying = true;
    this.error = null;
    this.success = null;
    try {
      const result = await applyReleaseRing(this.selectedRing, this.allowDowngrade);
      this.appliedRing = result.selectedRing;
      this.resolved = result.resolved;
      this.success = `${result.selectedRing} saved for the CLI and installer. No package was downloaded.`;
    } catch (error) {
      this.error = String(error);
    } finally {
      this.applying = false;
    }
  }

  render() {
    const changed = this.selectedRing !== this.appliedRing;
    const warning = this.resolved?.nonStable || this.resolved?.olderThanCurrent;
    const needsDowngradeApproval = this.resolved?.olderThanCurrent === true;
    return html`
      <section class="card" aria-label="Release ring">
        <div class="row">
          <div class="title">
            <h3>Release ring</h3>
            <p>Choose a validated pointer. Changes apply only after confirmation.</p>
          </div>
          <label>
            Ring
            <select
              aria-label="Release ring"
              .value=${this.selectedRing}
              @change=${this.choose}
              ?disabled=${this.loading || this.applying}
            >
              ${RELEASE_RINGS.map(ring => html`<option value=${ring}>${ring}</option>`)}
            </select>
          </label>
          <button
            @click=${this.apply}
            ?disabled=${!changed || this.loading || this.applying || !this.resolved?.canApply || (needsDowngradeApproval && !this.allowDowngrade)}
          >
            ${this.applying ? 'Applying…' : 'Apply for next update'}
          </button>
        </div>

        ${this.resolved ? html`
          <div class="identity">
            <div><span>Selected</span><br><code>${this.appliedRing}</code></div>
            <div><span>Resolved version</span><br><code>${this.resolved.version ?? 'unavailable'}</code></div>
            <div><span>Commit</span><br><code>${this.resolved.commit ?? 'unavailable'}</code></div>
            <div><span>Status</span><br><code>${this.resolved.status}</code></div>
          </div>
        ` : nothing}

        ${warning ? html`
          <div class="warning">
            ${this.resolved?.nonStable ? html`This is a non-stable ring. ` : nothing}
            ${this.resolved?.olderThanCurrent
              ? html`Version ${this.resolved.version} is older than installed ${this.currentVersion}. Explicit downgrade approval is required.`
              : html`Prerelease rings may be less tested than stable.`}
          </div>
        ` : nothing}

        ${needsDowngradeApproval ? html`
          <label class="approval">
            <input
              type="checkbox"
              .checked=${this.allowDowngrade}
              @change=${(event: Event) => { this.allowDowngrade = (event.target as HTMLInputElement).checked; }}
            >
            I understand this selects an older exact version.
          </label>
        ` : nothing}

        ${this.resolved && !this.resolved.canApply ? html`
          <div class="error">${this.resolved.reason ?? `${this.resolved.status} ring cannot be applied.`}</div>
        ` : nothing}
        ${this.error ? html`<div class="error">${this.error}</div>` : nothing}
        ${this.success ? html`<div class="success">${this.success}</div>` : nothing}
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-release-ring-switcher': OpenRappterReleaseRingSwitcher;
  }
}
