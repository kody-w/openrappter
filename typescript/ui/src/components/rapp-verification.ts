import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { isWorkVerified, unverifiedWork, type WorkVerification } from '../services/work-rapp.js';

@customElement('rapp-verification')
export class RappVerification extends LitElement {
  @property({ attribute: false }) verification?: WorkVerification;
  @property({ type: Boolean }) demo = false;
  @property({ type: Boolean }) compact = false;

  static styles = css`
    :host { display: block; font: 10px/1.6 "Segoe UI", Aptos, Calibri, sans-serif; min-width: 0; }
    .badge { color: var(--cp-text-muted); border: 1px solid var(--cp-border); background: var(--cp-surface-soft); border-radius: 5px; padding: 3px 6px; display: inline-block; }
    .verified { color: var(--cp-text); border-color: var(--cp-accent); }
    .invalid { color: var(--cp-danger); }
    summary { cursor: pointer; }
    summary:focus-visible { outline: 2px solid var(--cp-accent); outline-offset: 2px; }
    .detail { margin-top: 8px; color: var(--cp-text-muted); overflow-wrap: anywhere; }
    p { margin: 6px 0; }
    code { font-family: Consolas, "Courier New", monospace; overflow-wrap: anywhere; }
  `;

  render() {
    const proof = !this.demo && isWorkVerified(this.verification) ? this.verification : null;
    const state = proof ? 'verified' : this.verification?.state === 'invalid' ? 'invalid' : this.demo ? 'unverified'
      : this.verification?.state === 'unavailable' ? 'unavailable' : 'unverified';
    const label = proof ? 'RAPP/1 · verified integrity' : this.demo ? 'RAPP/1 · unverified demo'
      : state === 'invalid' ? 'RAPP/1 · verification failed' : state === 'unavailable' ? 'RAPP/1 · adapter unavailable' : 'RAPP/1 · unverified';
    const detail = this.demo ? 'Illustration only. No canonical frame exists and no example event is persisted.'
      : proof?.detail ?? (this.verification?.state === 'verified' ? unverifiedWork().detail : this.verification?.detail ?? unverifiedWork().detail);
    if (this.compact) return html`<span class="badge ${state}" data-rapp-status=${state} title=${detail}>${label}</span>`;
    return html`<details data-rapp-status=${state}>
      <summary class="badge ${state}">${label}</summary>
      <div class="detail"><p>${detail}</p>
        ${proof ? html`
          <p>Authority: ${proof.scan.body.trust.authority?.revision}
            <br><code>${proof.scan.body.trust.authority?.frame_hash}</code></p>
          <p>Source frame: <code>${proof.scan.source_frame_hash}</code></p>
          <p>Evidence frame: <code>${proof.scan.evidence_frame_hash}</code></p>
          <p>Committed memory head: #${proof.scan.memory.head.seq}
            <br><code>${proof.scan.memory.head.frame_hash}</code></p>
          <p>Committed body head: #${proof.scan.body.head.seq}
            <br><code>${proof.scan.body.head.frame_hash}</code></p>
        ` : nothing}
      </div>
    </details>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rapp-verification': RappVerification;
  }
}
