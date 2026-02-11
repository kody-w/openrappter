/**
 * Presence View Component
 * System health and connection status
 */

import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { gateway } from '../services/gateway.js';
import type { GatewayStatus, HealthResponse } from '../types.js';

@customElement('openrappter-presence')
export class OpenRappterPresence extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1.5rem;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
    }
    .header h2 { font-size: 1.125rem; font-weight: 600; }
    button {
      padding: 0.5rem 1rem;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 0.375rem;
      font-size: 0.875rem;
      cursor: pointer;
    }
    button:hover { background: var(--accent-hover); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }
    .card-title {
      font-weight: 600;
      margin-bottom: 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--border);
      font-size: 0.875rem;
    }
    .stat:last-child { border-bottom: none; }
    .stat-label { color: var(--text-secondary); }
    .stat-value { font-weight: 600; font-family: monospace; }
    .health-check {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0;
    }
    .health-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .health-dot.ok { background: var(--accent); }
    .health-dot.error { background: var(--error); }
    .health-dot.unknown { background: var(--text-secondary); }
    .overall-status {
      font-size: 1.5rem;
      font-weight: 700;
      text-transform: uppercase;
      margin-bottom: 1rem;
    }
    .overall-status.ok { color: var(--accent); }
    .overall-status.degraded { color: var(--warning); }
    .overall-status.error { color: var(--error); }
  `;

  @state() private status: GatewayStatus | null = null;
  @state() private health: HealthResponse | null = null;
  @state() private loading = true;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
  }

  private async refresh() {
    this.loading = true;
    try {
      const [s, h] = await Promise.allSettled([
        gateway.call<GatewayStatus>('status'),
        gateway.call<HealthResponse>('health'),
      ]);
      this.status = s.status === 'fulfilled' ? s.value : null;
      this.health = h.status === 'fulfilled' ? h.value : null;
    } catch { /* ignore */ }
    this.loading = false;
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  render() {
    if (this.loading) return html`<div>Loading system status...</div>`;

    return html`
      <div class="header">
        <h2>System Health</h2>
        <button @click=${this.refresh}>Refresh</button>
      </div>

      ${this.health
        ? html`<div class="overall-status ${this.health.status}">${this.health.status}</div>`
        : ''}

      <div class="grid">
        ${this.status
          ? html`
              <div class="card">
                <div class="card-title">📊 Gateway Status</div>
                <div class="stat">
                  <span class="stat-label">Port</span>
                  <span class="stat-value">${this.status.port}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Connections</span>
                  <span class="stat-value">${this.status.connections}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Uptime</span>
                  <span class="stat-value">${this.formatUptime(this.status.uptime)}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Version</span>
                  <span class="stat-value">${this.status.version}</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Started</span>
                  <span class="stat-value">${new Date(this.status.startedAt).toLocaleString()}</span>
                </div>
              </div>
            `
          : ''}

        ${this.health
          ? html`
              <div class="card">
                <div class="card-title">🏥 Health Checks</div>
                ${Object.entries(this.health.checks).map(
                  ([name, ok]) => html`
                    <div class="health-check">
                      <span class="health-dot ${ok === true ? 'ok' : ok === false ? 'error' : 'unknown'}"></span>
                      <span>${name}</span>
                    </div>
                  `,
                )}
              </div>
            `
          : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'openrappter-presence': OpenRappterPresence;
  }
}
